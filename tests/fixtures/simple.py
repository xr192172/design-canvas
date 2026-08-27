"""behavior_baseline 金丝雀夹具：纯函数，无 import 副作用，顶层无打印。

供 tests/behavior 真跑 harness 使用；每个函数覆盖一种可被基线对比的行为维度：
  - add            返回标量 → 返回值 repr 对比
  - describe_person 返回 dict（含 kwargs/默认参）→ 结构化 repr 对比
  - pick_evens     返回 list → 列表推导对比
  - safe_divide    抛 ZeroDivisionError → 异常路径对比
"""


def add(a, b):
    """加法：改动后返回值变化会被基线抓到。"""
    return a + b


def describe_person(name, age=18, tags=None):
    """返回 dict：kwargs + 默认参 + 排序化列表。"""
    return {"name": name, "age": age, "tags": sorted(tags or [])}


def pick_evens(items):
    """列表推导：行为应稳定。"""
    return [x for x in items if x % 2 == 0]


def safe_divide(a, b):
    """除零抛异常：异常路径变化可被基线抓到。"""
    return a / b
