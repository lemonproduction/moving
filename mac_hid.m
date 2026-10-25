#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
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

// macOS Chrome 활성 탭의 실제 웹 뷰포트 (x, y, w, h)를 AX API로 정확히 추출
int printChromeWebRect() {
    NSArray *apps = [[NSWorkspace sharedWorkspace] runningApplications];
    pid_t chromePid = 0;
    for (NSRunningApplication *app in apps) {
        if ([[app bundleIdentifier] isEqualToString:@"com.google.Chrome"]) {
            chromePid = [app processIdentifier];
            break;
        }
    }
    if (!chromePid) {
        printf("0,0,0,0\n");
        return 0;
    }

    AXUIElementRef appRef = AXUIElementCreateApplication(chromePid);
    CFArrayRef windowList = NULL;
    AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, (CFTypeRef *)&windowList);
    if (!windowList) {
        CFRelease(appRef);
        printf("0,0,0,0\n");
        return 0;
    }

    for (id win in (__bridge NSArray *)windowList) {
        AXUIElementRef winRef = (__bridge AXUIElementRef)win;
        CFTypeRef title = NULL;
        AXUIElementCopyAttributeValue(winRef, kAXTitleAttribute, &title);
        NSString *titleStr = (__bridge NSString *)title;
        if (!titleStr || [titleStr containsString:@"개발자 도구"] || [titleStr containsString:@"Task Manager"]) {
            if (title) CFRelease(title);
            continue;
        }

        CFTypeRef wpos = NULL, wsz = NULL;
        AXUIElementCopyAttributeValue(winRef, kAXPositionAttribute, &wpos);
        AXUIElementCopyAttributeValue(winRef, kAXSizeAttribute, &wsz);
        CGPoint wpt = CGPointZero; CGSize wsize = CGSizeZero;
        if (wpos) AXValueGetValue((AXValueRef)wpos, kAXValueTypeCGPoint, &wpt);
        if (wsz) AXValueGetValue((AXValueRef)wsz, kAXValueTypeCGSize, &wsize);
        if (wpos) CFRelease(wpos);
        if (wsz) CFRelease(wsz);

        if (wsize.width < 300 || wsize.height < 300) {
            if (title) CFRelease(title);
            continue;
        }

        __block CGRect bestRect = CGRectZero;
        void (^findWebArea)(AXUIElementRef, int) = ^(AXUIElementRef root, int maxD) {
            __block void (^rec)(AXUIElementRef, int) = ^(AXUIElementRef el, int d) {
                if (d > maxD) return;
                CFTypeRef pos = NULL, sz = NULL;
                AXUIElementCopyAttributeValue(el, kAXPositionAttribute, &pos);
                AXUIElementCopyAttributeValue(el, kAXSizeAttribute, &sz);
                CGPoint pt = CGPointZero; CGSize s = CGSizeZero;
                if (pos) AXValueGetValue((AXValueRef)pos, kAXValueTypeCGPoint, &pt);
                if (sz) AXValueGetValue((AXValueRef)sz, kAXValueTypeCGSize, &s);
                if (pos) CFRelease(pos);
                if (sz) CFRelease(sz);

                if (pt.y >= wpt.y + 60 && s.height > 200 && s.height < wsize.height - 50 && s.width >= wsize.width - 5) {
                    if (s.height > bestRect.size.height) {
                        bestRect = CGRectMake(pt.x, pt.y, s.width, s.height);
                    }
                }

                CFArrayRef ch = NULL;
                AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, (CFTypeRef *)&ch);
                if (ch) {
                    for (id c in (__bridge NSArray *)ch) {
                        rec((__bridge AXUIElementRef)c, d + 1);
                    }
                    CFRelease(ch);
                }
            };
            rec(root, 0);
        };

        findWebArea(winRef, 6);
        if (title) CFRelease(title);

        if (bestRect.size.width > 200 && bestRect.size.height > 200) {
            printf("%d,%d,%d,%d\n", (int)bestRect.origin.x, (int)bestRect.origin.y, (int)bestRect.size.width, (int)bestRect.size.height);
            CFRelease(windowList);
            CFRelease(appRef);
            return 0;
        }
    }

    CFRelease(windowList);
    CFRelease(appRef);
    printf("0,0,0,0\n");
    return 0;
}

int main(int argc, const char * argv[]) {
    if (argc < 2) return 1;
    const char *cmd = argv[1];

    if (strcmp(cmd, "get_chrome_rect") == 0) {
        return printChromeWebRect();
    } else if (strcmp(cmd, "move") == 0 && argc >= 4) {
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
