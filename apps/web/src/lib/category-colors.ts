const COLOR_CLASSES = {
  sky: "from-sky-400/80",
  emerald: "from-emerald-400/80",
  amber: "from-amber-400/80",
  rose: "from-rose-400/80",
  violet: "from-violet-400/80",
  cyan: "from-cyan-400/80",
  lime: "from-lime-400/80",
  pink: "from-pink-400/80",
};

const COLOR_NAMES = Object.keys(COLOR_CLASSES);

export function getCategoryColorClass(category: string): string {
  // Convert category string into a numeric hash
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Use a non-negative index derived from the hash
  const index = Math.abs(hash % COLOR_NAMES.length);
  const colorName = COLOR_NAMES[index] as keyof typeof COLOR_CLASSES;
  return COLOR_CLASSES[colorName];
}
