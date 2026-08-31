import React, { useMemo, useRef, useState } from 'react';
import {
  Image,
  PanResponder,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { colors } from '../lib/theme';

/** A pill on screen. Coordinates are in processed-image pixels. */
export interface CanvasMarker {
  id: string;
  x: number;
  y: number;
  /** True for pills the pipeline teased out of a clump. */
  highlight: boolean;
  userAdded: boolean;
}

interface Props {
  imageUri: string;
  /** Size of the coordinate space the markers live in. */
  imageWidth: number;
  imageHeight: number;
  markers: CanvasMarker[];
  /** Radius of one pill in image pixels, used to size the dots. */
  pillRadius: number;
  onAdd: (x: number, y: number) => void;
  onRemove: (id: string) => void;
  editable: boolean;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

/** The fields this component reads off a native touch. */
interface TouchPoint {
  pageX: number;
  pageY: number;
  locationX: number;
  locationY: number;
}

/** How the image sits inside the layout box once letterboxed. */
interface Fit {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Finger travel below this still counts as a tap rather than a drag. */
const TAP_SLOP = 8;
/** Taps within this many pill-radii of a dot remove it instead of adding one. */
const TAP_TARGET_RADII = 1.1;

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

/**
 * The photo with one dot per counted pill, pannable and zoomable, where a tap
 * adds a missed pill or removes a phantom one.
 *
 * This screen is the whole reason the app can promise an exact number. No
 * detector is right every time, so the product answer is not a better detector
 * alone but a detector plus a five-second way to fix it - which only works if
 * the user can see precisely what was counted. Hence dots rather than a bare
 * number, and hence zoom: on a tray of 200 pills a dot is a few pixels wide
 * and completely unverifiable without it.
 */
export default function PillCanvas({
  imageUri,
  imageWidth,
  imageHeight,
  markers,
  pillRadius,
  onAdd,
  onRemove,
  editable,
}: Props) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<Transform>(IDENTITY);

  const fit = useMemo<Fit>(() => {
    if (box.width === 0 || box.height === 0 || imageWidth === 0 || imageHeight === 0) {
      return { width: 0, height: 0, offsetX: 0, offsetY: 0, scale: 0 };
    }
    const scale = Math.min(box.width / imageWidth, box.height / imageHeight);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    return {
      width,
      height,
      offsetX: (box.width - width) / 2,
      offsetY: (box.height - height) / 2,
      scale,
    };
  }, [box, imageWidth, imageHeight]);

  /**
   * Everything the gesture handlers need, mirrored into refs.
   *
   * The PanResponder is built exactly once. Rebuilding it when the transform
   * changes - the obvious thing to do, since the handlers need the current
   * transform - swaps the view's handlers out from under an in-flight gesture,
   * and the responder system keeps delivering moves to the handler that was
   * granted. The pan then freezes after the first frame. Refs let the handlers
   * read fresh values without their identity ever changing.
   */
  const live = useRef({ box, fit, markers, pillRadius, editable, imageWidth, imageHeight });
  live.current = { box, fit, markers, pillRadius, editable, imageWidth, imageHeight };

  const transformRef = useRef<Transform>(IDENTITY);
  const applyTransform = (next: Transform) => {
    transformRef.current = next;
    setTransform(next);
  };

  const gesture = useRef({
    startDistance: 0,
    startTransform: IDENTITY,
    focalX: 0,
    focalY: 0,
    moved: 0,
    pinching: false,
  });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
    // A layout change (rotation, panel resize) invalidates the old pan offsets.
    applyTransform(IDENTITY);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          gesture.current.moved = 0;
          gesture.current.startTransform = transformRef.current;
          gesture.current.pinching = touches.length >= 2;
          if (touches.length >= 2) beginPinch(touches);
        },

        onPanResponderMove: (event, state) => {
          const touches = event.nativeEvent.touches;
          gesture.current.moved = Math.max(
            gesture.current.moved,
            Math.hypot(state.dx, state.dy),
          );

          if (touches.length >= 2) {
            if (!gesture.current.pinching) {
              // A second finger arrived mid-drag: re-anchor so the image does
              // not jump as the gesture changes character.
              gesture.current.pinching = true;
              gesture.current.startTransform = transformRef.current;
              beginPinch(touches);
              return;
            }
            if (gesture.current.startDistance <= 0) return;

            const distance = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY,
            );
            const start = gesture.current.startTransform;
            const scale = clamp(
              (start.scale * distance) / gesture.current.startDistance,
              MIN_SCALE,
              MAX_SCALE,
            );

            // Keep the content under the pinch midpoint pinned there, so the
            // zoom follows the fingers rather than the middle of the screen.
            const { width, height } = live.current.box;
            const cx = width / 2;
            const cy = height / 2;
            const fx = gesture.current.focalX - cx;
            const fy = gesture.current.focalY - cy;
            const x = fx - (scale * (fx - start.x)) / start.scale;
            const y = fy - (scale * (fy - start.y)) / start.scale;

            applyTransform({ scale, ...clampTranslation(x, y, scale) });
            return;
          }

          if (gesture.current.pinching) return;
          const start = gesture.current.startTransform;
          applyTransform({
            scale: start.scale,
            ...clampTranslation(start.x + state.dx, start.y + state.dy, start.scale),
          });
        },

        onPanResponderRelease: (event) => {
          const wasTap = !gesture.current.pinching && gesture.current.moved < TAP_SLOP;
          gesture.current.pinching = false;
          if (wasTap) handleTap(event.nativeEvent.locationX, event.nativeEvent.locationY);
        },

        onPanResponderTerminate: () => {
          gesture.current.pinching = false;
        },
      }),
    [],
  );

  function beginPinch(touches: TouchPoint[]) {
    // Distance is translation invariant, so window coordinates are fine here.
    gesture.current.startDistance = Math.hypot(
      touches[0].pageX - touches[1].pageX,
      touches[0].pageY - touches[1].pageY,
    );
    // The focal point is not translation invariant: it gets compared against
    // the container's own centre, so it has to be in container coordinates.
    // locationX/locationY are relative to the touch target, and the stage and
    // its children are pointerEvents="none", so that target is always this
    // container. Using pageX here would offset the zoom centre by wherever the
    // canvas happens to sit in the window.
    gesture.current.focalX = (touches[0].locationX + touches[1].locationX) / 2;
    gesture.current.focalY = (touches[0].locationY + touches[1].locationY) / 2;
  }

  function clampTranslation(x: number, y: number, scale: number) {
    const { box: b, fit: f } = live.current;
    // Never let the image be dragged completely out of view.
    const slackX = Math.max(0, (f.width * scale - b.width) / 2);
    const slackY = Math.max(0, (f.height * scale - b.height) / 2);
    return { x: clamp(x, -slackX, slackX), y: clamp(y, -slackY, slackY) };
  }

  /**
   * Undo the view transform to find which image pixel a touch landed on.
   *
   * React Native applies `transform` about the view's centre, so
   * screen = centre + translate + scale * (content - centre). This is that
   * solved for content, then un-letterboxed back into image pixels.
   */
  function toImageCoords(touchX: number, touchY: number) {
    const { box: b, fit: f } = live.current;
    const t = transformRef.current;
    const cx = b.width / 2;
    const cy = b.height / 2;
    const contentX = cx + (touchX - cx - t.x) / t.scale;
    const contentY = cy + (touchY - cy - t.y) / t.scale;
    return { x: (contentX - f.offsetX) / f.scale, y: (contentY - f.offsetY) / f.scale };
  }

  function handleTap(touchX: number, touchY: number) {
    const state = live.current;
    if (!state.editable || state.fit.scale === 0) return;

    const point = toImageCoords(touchX, touchY);
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > state.imageWidth ||
      point.y > state.imageHeight
    ) {
      return;
    }

    // Removing wins over adding: a tap on a dot means that dot. Nearest first,
    // so a dense clump stays correctable one pill at a time.
    const reach = Math.max(state.pillRadius * TAP_TARGET_RADII, 6);
    let nearest: CanvasMarker | null = null;
    let nearestDistance = Infinity;
    for (const marker of state.markers) {
      const distance = Math.hypot(marker.x - point.x, marker.y - point.y);
      if (distance < reach && distance < nearestDistance) {
        nearest = marker;
        nearestDistance = distance;
      }
    }

    if (nearest) onRemove(nearest.id);
    else onAdd(point.x, point.y);
  }

  const dotSize = Math.max(10, pillRadius * fit.scale * 1.05);

  return (
    <View style={styles.container} onLayout={onLayout} {...responder.panHandlers}>
      <View
        style={[
          styles.stage,
          {
            transform: [
              { translateX: transform.x },
              { translateY: transform.y },
              { scale: transform.scale },
            ],
          },
        ]}
        pointerEvents="none"
      >
        {fit.width > 0 && (
          <>
            <Image
              source={{ uri: imageUri }}
              style={{
                position: 'absolute',
                left: fit.offsetX,
                top: fit.offsetY,
                width: fit.width,
                height: fit.height,
              }}
              resizeMode="contain"
            />
            {markers.map((marker) => (
              <View
                key={marker.id}
                style={[
                  styles.dot,
                  {
                    left: fit.offsetX + marker.x * fit.scale - dotSize / 2,
                    top: fit.offsetY + marker.y * fit.scale - dotSize / 2,
                    width: dotSize,
                    height: dotSize,
                    borderRadius: dotSize / 2,
                    // Outlines are drawn pre-scale, so divide to keep them a
                    // constant thickness on screen at any zoom level.
                    borderWidth: Math.max(0.6, 2 / transform.scale),
                    borderColor: marker.userAdded
                      ? colors.accent
                      : marker.highlight
                        ? colors.warn
                        : 'rgba(255,255,255,0.95)',
                    backgroundColor: marker.userAdded
                      ? 'rgba(53,208,165,0.35)'
                      : marker.highlight
                        ? 'rgba(245,165,36,0.28)'
                        : 'rgba(53,208,165,0.18)',
                  },
                ]}
              />
            ))}
          </>
        )}
      </View>
    </View>
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', backgroundColor: '#000' },
  stage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  dot: { position: 'absolute' },
});
