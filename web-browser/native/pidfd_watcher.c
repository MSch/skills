#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/wait.h>
#include <node_api.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <uv.h>

typedef struct {
  napi_env env;
  napi_ref callback_ref;
  napi_ref self_ref;
  uv_poll_t poll;
  int fd;
  int closed;
  int poll_initialized;
} watcher_t;

static void throw_errno(napi_env env, const char *prefix) {
  char message[256];
  snprintf(message, sizeof(message), "%s: %s", prefix, strerror(errno));
  napi_throw_error(env, NULL, message);
}

static void free_watcher(uv_handle_t *handle) {
  watcher_t *watcher = (watcher_t *)handle->data;
  if (!watcher) return;

  if (watcher->fd >= 0) {
    close(watcher->fd);
    watcher->fd = -1;
  }
  if (watcher->callback_ref) {
    napi_delete_reference(watcher->env, watcher->callback_ref);
    watcher->callback_ref = NULL;
  }
  if (watcher->self_ref) {
    napi_delete_reference(watcher->env, watcher->self_ref);
    watcher->self_ref = NULL;
  }
  free(watcher);
}

static void close_watcher(watcher_t *watcher) {
  if (!watcher || watcher->closed) return;
  watcher->closed = 1;
  if (watcher->poll_initialized) {
    uv_poll_stop(&watcher->poll);
    uv_close((uv_handle_t *)&watcher->poll, free_watcher);
  } else {
    free_watcher((uv_handle_t *)&watcher->poll);
  }
}

static void emit_exit(watcher_t *watcher, int status, const char *message) {
  napi_handle_scope scope;
  napi_open_handle_scope(watcher->env, &scope);

  napi_value callback;
  napi_value global;
  napi_get_reference_value(watcher->env, watcher->callback_ref, &callback);
  napi_get_global(watcher->env, &global);

  napi_value argv[2];
  napi_create_int32(watcher->env, status, &argv[0]);
  if (message) {
    napi_create_string_utf8(watcher->env, message, NAPI_AUTO_LENGTH, &argv[1]);
  } else {
    napi_get_null(watcher->env, &argv[1]);
  }

  napi_value result;
  napi_call_function(watcher->env, global, callback, 2, argv, &result);
  napi_close_handle_scope(watcher->env, scope);
}

static void on_pidfd_event(uv_poll_t *handle, int status, int events) {
  watcher_t *watcher = (watcher_t *)handle->data;
  if (!watcher || watcher->closed) return;

  if (status < 0) {
    char message[128];
    snprintf(message, sizeof(message), "pidfd poll failed: %s", uv_strerror(status));
    emit_exit(watcher, status, message);
    close_watcher(watcher);
    return;
  }

  if (events & (UV_READABLE | UV_DISCONNECT)) {
    emit_exit(watcher, 0, NULL);
    close_watcher(watcher);
  }
}

static napi_value watcher_close(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  size_t argc = 0;
  napi_get_cb_info(env, info, &argc, NULL, &this_arg, NULL);

  watcher_t *watcher;
  napi_unwrap(env, this_arg, (void **)&watcher);
  close_watcher(watcher);
  return NULL;
}

static napi_value watch_pid(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "watchPid(pid, callback) requires 2 arguments");
    return NULL;
  }

  int64_t pid;
  napi_status napi_status = napi_get_value_int64(env, args[0], &pid);
  if (napi_status != napi_ok || pid <= 0) {
    napi_throw_type_error(env, NULL, "pid must be a positive integer");
    return NULL;
  }

  napi_valuetype callback_type;
  napi_typeof(env, args[1], &callback_type);
  if (callback_type != napi_function) {
    napi_throw_type_error(env, NULL, "callback must be a function");
    return NULL;
  }

  int fd = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
  if (fd < 0) {
    throw_errno(env, "pidfd_open failed");
    return NULL;
  }

  int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);

  watcher_t *watcher = calloc(1, sizeof(watcher_t));
  if (!watcher) {
    close(fd);
    napi_throw_error(env, NULL, "failed to allocate pidfd watcher");
    return NULL;
  }
  watcher->env = env;
  watcher->fd = fd;

  napi_value object;
  napi_create_object(env, &object);
  napi_create_reference(env, args[1], 1, &watcher->callback_ref);
  napi_create_reference(env, object, 1, &watcher->self_ref);
  napi_wrap(env, object, watcher, NULL, NULL, NULL);

  napi_value close_fn;
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, watcher_close, NULL, &close_fn);
  napi_set_named_property(env, object, "close", close_fn);

  uv_loop_t *loop;
  napi_get_uv_event_loop(env, &loop);
  watcher->poll.data = watcher;
  int uv_status = uv_poll_init(loop, &watcher->poll, fd);
  if (uv_status < 0) {
    close_watcher(watcher);
    napi_throw_error(env, NULL, uv_strerror(uv_status));
    return NULL;
  }
  watcher->poll_initialized = 1;

  uv_status = uv_poll_start(&watcher->poll, UV_READABLE | UV_DISCONNECT, on_pidfd_event);
  if (uv_status < 0) {
    close_watcher(watcher);
    napi_throw_error(env, NULL, uv_strerror(uv_status));
    return NULL;
  }

  return object;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "watchPid", NAPI_AUTO_LENGTH, watch_pid, NULL, &fn);
  napi_set_named_property(env, exports, "watchPid", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
