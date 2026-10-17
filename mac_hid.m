#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void moveMouse(double x, double y) {
    CGPoint pt = CGPointMake(x, y);
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, pt, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, move);
    CFRelease(move);
}

void clickMouse(double x, double y) {
    CGPoint pt = CGPointMake(x, y);
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, pt, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, move);
    CFRelease(move);
    usleep(35000);

    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, down);
    usleep(45000);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
}

void scrollMouse(int totalDy, double x, double y) {
    if (x > 0 && y > 0) {
        moveMouse(x, y);
        usleep(20000);
    }
    // 부드러운 관성 스크롤을 위해 여러 단계로 나누어 전송
    int steps = 6;
    int stepDy = totalDy / steps;
    if (stepDy == 0) stepDy = (totalDy > 0) ? 1 : -1;
    for (int i = 0; i < steps; i++) {
        CGEventRef scroll = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 1, stepDy);
        CGEventPost(kCGHIDEventTap, scroll);
        CFRelease(scroll);
        usleep(12000);
    }
}

void pressKey(int keycode, uint64_t flags) {
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, false);
    if (flags != 0) {
        CGEventSetFlags(down, (CGEventFlags)flags);
        CGEventSetFlags(up, (CGEventFlags)flags);
    }
    CGEventPost(kCGHIDEventTap, down);
    usleep(35000);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
}

int main(int argc, const char * argv[]) {
    if (argc < 2) return 1;
    const char *cmd = argv[1];

    if (strcmp(cmd, "move") == 0 && argc >= 4) {
        moveMouse(atof(argv[2]), atof(argv[3]));
    } else if (strcmp(cmd, "click") == 0 && argc >= 4) {
        clickMouse(atof(argv[2]), atof(argv[3]));
    } else if (strcmp(cmd, "scroll") == 0 && argc >= 3) {
        int dy = atoi(argv[2]);
        double x = (argc >= 5) ? atof(argv[3]) : -1;
        double y = (argc >= 5) ? atof(argv[4]) : -1;
        scrollMouse(dy, x, y);
    } else if (strcmp(cmd, "key") == 0 && argc >= 3) {
        pressKey(atoi(argv[2]), 0);
    } else if (strcmp(cmd, "cmdkey") == 0 && argc >= 3) {
        pressKey(atoi(argv[2]), kCGEventFlagMaskCommand);
    }
    return 0;
}
