package com.acme.legacy;

import java.util.List;

public class OrderService {
  // 声明 JDK 8，但下面误用了现代特性——编译 8 会失败，正是"契约对不上的部分"
  public String render(List<String> items) {
    var joined = String.join(", ", items); // JDK 10 var
    String json = """
      {"items": %s}
      """.formatted(joined);               // JDK 15 文本块
    return json;
  }

  public boolean isNew(Object o) {
    return o instanceof String s && s.length() > 0; // JDK 16 instanceof 模式匹配
  }
}

record LineItem(String sku, int qty) {} // JDK 16 record
