import { Position } from "@osujs/math";
import { isHitCircle, isSlider, OsuHitObject } from "../hitobjects/Types";
import { OSU_PLAYFIELD_HEIGHT, OSU_PLAYFIELD_WIDTH } from "../playfield";

// The axes of osu!lazer's Mirror mod. Hard Rock is a vertical reflection.
export type MirrorReflection = "HORIZONTAL" | "VERTICAL" | "BOTH";

export class MirrorMod {
  static reflect = (hitObjects: OsuHitObject[], reflection: MirrorReflection) => {
    const horizontal = reflection !== "VERTICAL";
    const vertical = reflection !== "HORIZONTAL";
    const reflectPosition = ({ x, y }: Position) => ({
      x: horizontal ? OSU_PLAYFIELD_WIDTH - x : x,
      y: vertical ? OSU_PLAYFIELD_HEIGHT - y : y,
    });
    // Offsets are relative to the slider head
    const reflectOffset = (offset: Position) => {
      if (horizontal) offset.x *= -1;
      if (vertical) offset.y *= -1;
    };

    hitObjects.forEach((h) => {
      if (isHitCircle(h)) {
        h.position = reflectPosition(h.position);
        h.unstackedPosition = reflectPosition(h.unstackedPosition);
      } else if (isSlider(h)) {
        // TODO: Need to set invalid as well or just recreate the checkpoints from control points
        h.head.position = reflectPosition(h.head.position);
        h.head.unstackedPosition = reflectPosition(h.head.unstackedPosition);
        h.path.controlPoints.forEach((p) => reflectOffset(p.offset));
        h.path.makeInvalid();
        h.checkPoints.forEach((p) => reflectOffset(p.offset));
      }
      // Spinners are always in the center
    });
  };
}
