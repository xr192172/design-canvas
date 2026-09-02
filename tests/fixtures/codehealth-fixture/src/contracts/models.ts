// code_health 夹具 · 契约层：只放类型（被积木/胶水消费）
export interface User {
  id: number;
  name: string;
}

// 刻意未在任何地方引用 → 未使用导出
export interface Order {
  id: number;
}
