// Ambient from the agent: "put my photos on the TV" opens the lean-back display in the app.
// The server only tells open windows to show it; choosing and drawing the posts happens there.

import { z } from 'zod';
import { broadcast } from './events.ts';
import type { ToolDef } from './agent/types.ts';

export const ambientTools: ToolDef[] = [
  {
    name: 'open_ambient',
    kind: 'read',
    description:
      'Open Ambient: a slow, full-screen display of the feed for a second monitor, a TV or a quiet moment. Pictures fill the screen and drift, short posts are set big, articles get a title card. It changes nothing and never marks posts read. Optionally narrow it to one view, photos only, or one person, and set the pace.',
    shape: {
      view: z.string().max(80).optional().describe('A view id or name (e.g. "Worth reading", "Saved", a saved view); the current view when omitted'),
      photosOnly: z.boolean().optional().describe('Only posts with a picture or video thumbnail'),
      person: z.string().max(80).optional().describe("A person's name or handle"),
      pace: z.number().min(5).max(60).optional().describe('Seconds per post; rounded to 8, 15 or 30'),
    },
    label: () => 'Opened Ambient',
    run: (a) => {
      broadcast({ type: 'ui', action: { kind: 'ambient', view: a.view ?? null, photosOnly: a.photosOnly === true, person: a.person ?? null, pace: a.pace ?? null } });
      const bits = [a.view && `view “${a.view}”`, a.photosOnly && 'photos only', a.person && `only ${a.person}`, a.pace && `about ${a.pace}s each`].filter(Boolean);
      return { text: `Opened Ambient on screen${bits.length ? ` (${bits.join(', ')})` : ''}. In a browser, full screen needs one click on its button or the f key; the desktop app goes full screen by itself.` };
    },
  },
];
