#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

#define TAG "NODEJS-MOBILE"

namespace {

int g_pipe[2];

// Node 的 stdout/stderr 转到 logcat（Node 里没有终端，不转就看不到任何日志）。
void* pump_logcat(void*) {
  char buffer[1024];
  std::string pending;
  ssize_t count;
  while ((count = read(g_pipe[0], buffer, sizeof(buffer))) > 0) {
    pending.append(buffer, static_cast<size_t>(count));
    size_t newline;
    while ((newline = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, newline);
      int priority = line.find("Error") != std::string::npos ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO;
      __android_log_write(priority, TAG, line.c_str());
      pending.erase(0, newline + 1);
    }
    if (pending.size() > 8192) {
      __android_log_write(ANDROID_LOG_INFO, TAG, pending.c_str());
      pending.clear();
    }
  }
  return nullptr;
}

void redirect_stdout_stderr() {
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(g_pipe) != 0) return;
  dup2(g_pipe[1], STDOUT_FILENO);
  dup2(g_pipe[1], STDERR_FILENO);
  pthread_t thread;
  pthread_create(&thread, nullptr, pump_logcat, nullptr);
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_io_github_jackotom_hongguo_MainActivity_startNodeWithArguments(
    JNIEnv* env, jclass, jobjectArray arguments, jstring modulesPath, jboolean redirectOutput) {
  if (redirectOutput) redirect_stdout_stderr();

  const jsize argc = env->GetArrayLength(arguments);
  std::vector<std::string> args;
  args.reserve(static_cast<size_t>(argc));
  size_t total = 0;
  for (jsize i = 0; i < argc; i++) {
    auto value = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
    const char* chars = env->GetStringUTFChars(value, nullptr);
    args.emplace_back(chars);
    env->ReleaseStringUTFChars(value, chars);
    env->DeleteLocalRef(value);
    total += args.back().size() + 1;
  }

  const char* modules = env->GetStringUTFChars(modulesPath, nullptr);
  setenv("NODE_PATH", modules, 1);
  env->ReleaseStringUTFChars(modulesPath, modules);

  // node::Start 会长期持有 argv 里的指针，必须是一块连续内存。
  std::vector<char> buffer(total);
  std::vector<char*> argv;
  argv.reserve(static_cast<size_t>(argc));
  size_t offset = 0;
  for (const auto& arg : args) {
    std::memcpy(buffer.data() + offset, arg.c_str(), arg.size() + 1);
    argv.push_back(buffer.data() + offset);
    offset += arg.size() + 1;
  }

  __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start %s", argv.empty() ? "" : argv[0]);
  return node::Start(static_cast<int>(argv.size()), argv.data());
}
