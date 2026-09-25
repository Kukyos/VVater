import React from 'react';
import { Composition } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';
import { Film, TOTAL, FPS } from './Film';

loadFont('normal', { weights: ['200', '300', '400', '500', '600'], subsets: ['latin'] });

export const RemotionRoot: React.FC = () => (
  <Composition id="Film" component={Film} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
);
