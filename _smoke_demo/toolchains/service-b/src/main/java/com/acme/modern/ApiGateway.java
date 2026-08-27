package com.acme.modern;

import javax.xml.bind.JAXBContext; // 声明 JDK 21，但 JAXB 自 JDK 11 起不再内置——契约对不上
import javax.annotation.PostConstruct;

public class ApiGateway {
  private java.util.Observable events; // JDK 9 起废弃

  @PostConstruct
  void init() throws Exception {
    JAXBContext ctx = JAXBContext.newInstance(OrderDto.class); // 需要 jakarta.xml.bind 依赖或换解析方案
  }

  static class OrderDto {}
}
