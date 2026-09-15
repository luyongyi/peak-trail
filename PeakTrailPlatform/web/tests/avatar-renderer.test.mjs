import assert from "node:assert/strict";
import test from "node:test";
import { createAvatarCamera, selectedTextureReference } from "../src/avatar-renderer.js";

test("avatar camera supplies a complete, forward-facing orthographic frustum", () => {
  class OrthographicCamera {
    constructor(...parameters) {
      this.parameters = parameters;
      [this.left, this.right, this.top, this.bottom, this.near, this.far] = parameters;
    }
  }

  const camera = createAvatarCamera({ OrthographicCamera }, 4, 0.75);
  assert.deepEqual(camera.parameters, [-1.5, 1.5, 2, -2, 0.01, 20]);
  assert.equal(camera.parameters.length, 6);
  assert.ok(camera.left < camera.right);
  assert.ok(camera.bottom < camera.top);
  assert.ok(camera.near > 0 && camera.near < 3);
  assert.ok(camera.far > 3);
});

test("avatar face cards use the exact-build decoded mask instead of losing hidden RGB", () => {
  const assets = {
    components: {
      eyes: {
        entry: {
          texture: "textures/raw-eyes.png",
          preview: "previews/eyes-5.png",
          textureEncoding: "peak-face-mask",
        },
      },
      mouth: null,
      accessory: null,
    },
  };

  assert.deepEqual(selectedTextureReference("eyes", assets), {
    reference: "previews/eyes-5.png",
    decodeRole: null,
    faceRole: "eyes",
  });
});
