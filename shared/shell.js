// 全站共用：品牌名稱只在這裡改一次（暫名）
export const BRAND = '生活小工具箱';

export function applyBrand() {
  for (const el of document.querySelectorAll('[data-brand]')) el.textContent = BRAND;
}

applyBrand();
