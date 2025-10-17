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

// カテゴリ文字列から色を決定する
export function getCategoryColorClass(category: string): string {
  // 簡単なハッシュ関数でカテゴリ文字列を数値に変換
  let hash = 0;
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash);
  }
  // 負にならないようにし、色の数で割った余りをインデックスとする
  const index = Math.abs(hash % COLOR_NAMES.length);
  const colorName = COLOR_NAMES[index] as keyof typeof COLOR_CLASSES;
  return COLOR_CLASSES[colorName];
}
