package probe

// Package probe — ActualDSLLoader: Observe 观测事实的结构化读取（P2）。
//
// 职责：把探针落盘的裸观测（events.jsonl）读成结构化的 probe.Event 流，
// 交给 Aggregator 聚合画像。这是「actual DSL」的第一个环节——只做读取与
// 解析，不做任何判定。
//
// 与 P1 JudgeLog 的分工：JudgeLog 是行为判定（规则秒判），本 loader 只负责
// 把观测喂给「事实画像」链路（actual.dsl.json），两者读同一份 events.jsonl，
// 视角不同（判定 vs 画像）。

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// ActualDSLLoader 从 JSONL 读取探针事件。格式错误行会被跳过并计数，
// 不让单条脏数据毁掉整份画像（观测是批量可再生事实，容错优先）。
type ActualDSLLoader struct {
	r io.Reader
}

// NewActualDSLLoader 创建读取器。
func NewActualDSLLoader(r io.Reader) *ActualDSLLoader {
	return &ActualDSLLoader{r: r}
}

// Load 读取全部事件，返回解析到的事件与跳过的坏行数。文件完全不可解析时
// 返回 err（调用方决定是否降级为空画像）。
func (l *ActualDSLLoader) Load() ([]Event, int, error) {
	var events []Event
	skipped := 0
	sc := bufio.NewScanner(l.r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			skipped++
			continue
		}
		events = append(events, ev)
	}
	if err := sc.Err(); err != nil {
		return nil, skipped, err
	}
	if len(events) == 0 && skipped > 0 {
		return nil, skipped, fmt.Errorf("actual-dsl: no parsable events (%d bad lines)", skipped)
	}
	return events, skipped, nil
}

// LoadFile 从文件读取事件。文件不存在返回 os.ErrNotExist。
func (l *ActualDSLLoader) LoadFile(path string) ([]Event, int, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer fh.Close()
	return (&ActualDSLLoader{r: fh}).Load()
}