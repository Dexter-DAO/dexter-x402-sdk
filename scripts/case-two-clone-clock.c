// Local validator only. Shift realtime without changing the host clock, account
// data, monotonic timers or file timestamps. Direct syscalls avoid Agave's
// allocator/loader recursion with libfaketime's clock_gettime initialization.
#define _GNU_SOURCE
#include <stdlib.h>
#include <time.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <unistd.h>

static time_t offset_seconds(void) {
    const char *value = getenv("FAKETIME");
    if (!value) return 0;
    int sign = *value == '-' ? -1 : 1;
    if (*value == '+' || *value == '-') value++;
    time_t seconds = 0;
    while (*value >= '0' && *value <= '9') seconds = seconds * 10 + *value++ - '0';
    return seconds * sign;
}
int clock_gettime(clockid_t id, struct timespec *value) {
    int result = (int)syscall(SYS_clock_gettime, id, value);
    if (!result && (id == CLOCK_REALTIME || id == CLOCK_REALTIME_COARSE)) value->tv_sec += offset_seconds();
    return result;
}
int gettimeofday(struct timeval *value, void *timezone) {
    int result = (int)syscall(SYS_gettimeofday, value, timezone);
    if (!result) value->tv_sec += offset_seconds();
    return result;
}
time_t time(time_t *value) {
    time_t result = (time_t)syscall(SYS_time, NULL);
    if (result == (time_t)-1) return result;
    result += offset_seconds();
    if (value) *value = result;
    return result;
}
