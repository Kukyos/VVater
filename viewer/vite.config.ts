import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Cesium is taken as @cesium/engine + @cesium/widgets rather than the `cesium` wrapper.
// The wrapper pulls both, and if their engine ranges disagree npm nests a second copy of
// @cesium/engine. Two engines means two copies of ContextLimits: the Viewer populates
// one and VoxelPrimitive reads the other, so voxel rendering dies with "the GL context
// does not support a 3D texture large enough". Depending on the two packages directly,
// pinned in step, makes that impossible rather than merely unlikely.
const ENGINE = "node_modules/@cesium/engine";

export default defineConfig({
  define: { CESIUM_BASE_URL: JSON.stringify("/cesium") },
  resolve: { dedupe: ["@cesium/engine", "@cesium/widgets"] },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: `${ENGINE}/Build/Workers`, dest: "cesium" },
        { src: `${ENGINE}/Build/ThirdParty`, dest: "cesium" },
        { src: `${ENGINE}/Source/Assets`, dest: "cesium" },
      ],
    }),
  ],
  server: { port: 5173 },
});
