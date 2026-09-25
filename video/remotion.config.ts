import { Config } from '@remotion/cli/config';

// PNG frames and CRF 16: the cards are light type on near-black, where JPEG ringing and
// banding show first, and the clips are already CRF 16 from capture.cjs.
Config.setVideoImageFormat('png');
Config.setCrf(16);
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');
Config.setChromiumOpenGlRenderer('angle');
Config.setOverwriteOutput(true);
// 2, not 4: at 4 the render ran the machine out of memory at 43 % (2026-09-25).
Config.setConcurrency(2);
