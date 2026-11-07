import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import { Box, Text, measureElement, useBoxMetrics, useInput, useStdin, type DOMElement } from "ink";
import { TUI_ASCII, TUI_COLORS } from "../theme.js";
import type { TerminalMouseEvent } from "../terminal.js";

type ScrollViewProps = {
  children: React.ReactNode;
  width: number;
  maxHeight?: number;
  footer?: boolean;
  permission?: boolean;
};

/** Follow new output until the user scrolls away; both input paths share one position. */
export function ScrollView({
  children,
  width,
  maxHeight,
  footer = false,
  permission = false,
}: ScrollViewProps): React.ReactElement {
  const rootRef = useRef<DOMElement>(null);
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const latestRef = useRef<DOMElement>(null);
  const dragOffset = useRef<number | null>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const { stdin } = useStdin();
  const [position, setPosition] = useState<number | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const maximum = Math.max(0, content.height - viewport.height);
  const top = position === null ? maximum : Math.min(position, maximum);
  const thumbSize = Math.max(
    1,
    Math.round((viewport.height * viewport.height) / Math.max(1, content.height)),
  );
  const trackSize = Math.max(0, viewport.height - thumbSize);
  const thumbTop = maximum === 0 ? 0 : Math.round((top / maximum) * trackSize);

  function moveTo(next: number): void {
    const bounded = Math.max(0, Math.min(maximum, next));
    positionRef.current = bounded === maximum ? null : bounded;
    setPosition(positionRef.current);
  }

  function scrollBy(delta: number): number {
    const before = positionRef.current === null ? maximum : Math.min(positionRef.current, maximum);
    const after = Math.max(0, Math.min(maximum, before + delta));
    moveTo(after);
    return delta - (after - before);
  }

  useInput((_input, key) => {
    if (!key.pageUp && !key.pageDown) return;
    if (footer !== (key.meta || permission)) return;
    const step = Math.max(1, viewport.height - 1);
    scrollBy(key.pageUp ? -step : step);
  });

  const onMouse = useEffectEvent((event: TerminalMouseEvent) => {
    if (event.kind === "wheel") {
      if (event.fallback ? footer : !contains(rootRef.current, event)) return;
      if (!footer) event.primaryVisited = true;
      event.remaining = scrollBy(event.remaining);
      return;
    }
    if (event.kind === "release") {
      dragOffset.current = null;
      return;
    }
    if (event.button !== 0) return;
    if (event.kind === "press" && contains(latestRef.current, event)) {
      moveTo(maximum);
      return;
    }
    if (!viewportRef.current || maximum === 0) return;
    const rect = measureElement(viewportRef.current);
    const row = event.y - rect.y;
    if (
      event.kind === "press" &&
      event.x === rect.x + rect.width - 1 &&
      row >= 0 &&
      row < rect.height
    ) {
      dragOffset.current =
        row >= thumbTop && row < thumbTop + thumbSize ? row - thumbTop : Math.floor(thumbSize / 2);
    } else if (event.kind !== "move" || dragOffset.current === null) {
      return;
    }
    moveTo(trackSize === 0 ? 0 : Math.round(((row - dragOffset.current) / trackSize) * maximum));
  });

  useEffect(() => {
    stdin.on("coil:mouse", onMouse);
    return () => {
      stdin.off("coil:mouse", onMouse);
    };
  }, [stdin]);

  return (
    <Box
      ref={rootRef}
      flexDirection="column"
      width={width}
      flexGrow={footer ? 0 : 1}
      flexShrink={footer ? 0 : 1}
      {...(footer ? { maxHeight } : { flexBasis: 0 })}
      minHeight={0}
      overflow="hidden"
    >
      {footer && maximum > 0 && (
        <Box height={1} flexShrink={0} paddingX={1}>
          <Text color={TUI_COLORS.muted} wrap="truncate-end">
            {permission ? "Scroll to review the operation" : "Scroll to review your draft"}
          </Text>
        </Box>
      )}
      {!footer && (
        <Box height={1} flexShrink={0} paddingX={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={TUI_COLORS.muted} wrap="truncate-end">
              {position === null ? "Conversation" : "Reading history"} · scroll to browse
            </Text>
          </Box>
          {position !== null && maximum > 0 && (
            <Box ref={latestRef} flexShrink={0} paddingLeft={1}>
              <Text color={TUI_COLORS.primary}>{TUI_ASCII ? "v" : "↓"} Latest</Text>
            </Box>
          )}
        </Box>
      )}
      <Box ref={viewportRef} flexGrow={1} minHeight={0} overflow="hidden">
        <Box flexDirection="column" width={Math.max(1, width - 1)} overflow="hidden">
          <Box ref={contentRef} flexDirection="column" flexShrink={0} top={-top}>
            {children}
          </Box>
        </Box>
        <Box width={1} flexShrink={0}>
          {maximum > 0 && viewport.height > 0 && (
            <Text>
              {Array.from({ length: viewport.height }, (_, row) => (
                <Text
                  key={row}
                  color={
                    row >= thumbTop && row < thumbTop + thumbSize
                      ? TUI_COLORS.border
                      : TUI_COLORS.muted
                  }
                >
                  {row >= thumbTop && row < thumbTop + thumbSize
                    ? TUI_ASCII
                      ? "#"
                      : "┃"
                    : TUI_ASCII
                      ? "|"
                      : "│"}
                  {row < viewport.height - 1 ? "\n" : ""}
                </Text>
              ))}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function contains(element: DOMElement | null, event: TerminalMouseEvent): boolean {
  if (!element) return false;
  const rect = measureElement(element);
  return (
    event.x >= rect.x &&
    event.x < rect.x + rect.width &&
    event.y >= rect.y &&
    event.y < rect.y + rect.height
  );
}
