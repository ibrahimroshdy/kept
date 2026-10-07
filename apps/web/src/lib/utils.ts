// shadcn's aria base imports `cn` from here (components.json "utils" alias). The D132 type-scale
// names are registered as font sizes, or `text-small` would be merged away as a colour.
import { createCn } from 'cn/config';

export const cn = createCn({
  extend: {
    classGroups: { 'font-size': [{ text: ['display', 'title', 'body', 'small', 'label'] }] },
  },
});
