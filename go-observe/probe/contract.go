package probe

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// Verdict classifies a single event against a contract.
type Verdict struct {
	Event  Event  `json:"event"`
	Rule   string `json:"rule"`   // contract rule id that fired
	Result string `json:"result"` // ok | deviation
	Reason string `json:"reason"` // why it deviates (or why ok)
	// LLM 是可选的行为级复核结果（use_llm 时由判定服务产出），nil = 未做 LLM 复核。
	LLM *LLMVerdict `json:"llm,omitempty"`
}

// Judge evaluates events against a set of contract rules.
type Judge struct {
	rules []rule
}

type rule struct {
	id   string
	pred func(Event) (result, reason string)
}

// AddRule registers a contract predicate. The first rule that returns
// "deviation" wins; if none deviate, the event is ok.
func (j *Judge) AddRule(id string, pred func(Event) (string, string)) *Judge {
	j.rules = append(j.rules, rule{id: id, pred: pred})
	return j
}

// JudgeEvent runs all rules and returns the verdict.
func (j *Judge) JudgeEvent(ev Event) Verdict {
	for _, r := range j.rules {
		result, reason := r.pred(ev)
		if result == "deviation" {
			return Verdict{Event: ev, Result: "deviation", Reason: reason, Rule: r.id}
		}
	}
	return Verdict{Event: ev, Result: "ok", Reason: "no contract violation", Rule: ""}
}

// JudgeLog reads events from a JSONL reader and produces a verdict for each.
func (j *Judge) JudgeLog(r io.Reader) ([]Verdict, error) {
	var verdicts []Verdict
	// 2026-08-16 超长行修复（回迁自历史迁移）：ReadBytes 逐行读取，
	// Scanner 1MB 行上限会在超长事件行（探针捕获整段流式消息可达 10MB+）
	// 处 ErrTooLong 中止整个判定。
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSpace(line)
			if len(line) > 0 {
				var ev Event
				if uerr := json.Unmarshal(line, &ev); uerr != nil {
					return nil, fmt.Errorf("parse event line %q: %w", string(line), uerr)
				}
				verdicts = append(verdicts, j.JudgeEvent(ev))
			}
		}
		if err != nil {
			if err == io.EOF {
				return verdicts, nil
			}
			return nil, err
		}
	}
}

// SilentErrorDiscard is the minimal observe contract. The expectation comes
// from design intent (llm-design): at a site where an error would otherwise
// be silently discarded, the captured error must be nil or provably benign.
// It is not sourced from any external rule library. Benignity is
// operation-aware — captured as Fields["op"] at emit time:
//
//	remove / cleanup : os.IsNotExist is benign (nothing to clean).
//	writefile / save : NOTHING is benign — any error means data was not
//	                   persisted (a missing parent dir yields ENOENT, which
//	                   os.IsNotExist would wrongly call benign).
//	mkdirall         : NOTHING is benign — the dir could not be ensured.
func SilentErrorDiscard(ev Event) (string, string) {
	errStr, _ := ev.Fields["err"].(string)
	if errStr == "" {
		return "ok", "err is nil — nothing was discarded"
	}
	op, _ := ev.Fields["op"].(string)
	switch op {
	case "remove", "remove-tmp", "cleanup":
		if benign, _ := ev.Fields["benign"].(bool); benign {
			return "ok", "benign: os.IsNotExist on cleanup — nothing to clean"
		}
		return "deviation", fmt.Sprintf("cleanup error silently discarded: %q", errStr)
	default: // writefile / save / mkdirall — no error is benign
		return "deviation", fmt.Sprintf("non-benign error silently discarded (op=%s): %q", op, errStr)
	}
}

// RenderReport groups verdicts and returns a human-readable deviation report.
func RenderReport(verdicts []Verdict) string {
	var okCount, devCount int
	var dev []Verdict
	for _, v := range verdicts {
		if v.Result == "deviation" {
			devCount++
			dev = append(dev, v)
		} else {
			okCount++
		}
	}
	sort.Slice(dev, func(i, j int) bool {
		return dev[i].Event.Probe < dev[j].Event.Probe
	})

	var b strings.Builder
	b.WriteString(fmt.Sprintf("摄像头偏差报告：%d 个事件 · %d ok · %d 偏差\n", len(verdicts), okCount, devCount))
	if devCount == 0 {
		b.WriteString("  ✓ 所有观测值符合契约\n")
		return b.String()
	}
	b.WriteString("\n▎偏差（观测值不符合设计/契约）\n")
	for _, v := range dev {
		fmt.Fprintf(&b, "  ✗ [%s] probe=%s source=%s\n", v.Rule, v.Event.Probe, v.Event.Source)
		fmt.Fprintf(&b, "      %s\n", v.Reason)
		for k, val := range v.Event.Fields {
			fmt.Fprintf(&b, "      %s=%v\n", k, val)
		}
	}
	return b.String()
}

// JudgeLogFile runs the judge over a JSONL log file and returns verdicts.
func (j *Judge) JudgeLogFile(path string) ([]Verdict, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	return j.JudgeLog(fh)
}

// loadEvents 从 JSONL 读取器解析全部 Event（供 JudgeClient 批量远程判定）。
// 同 JudgeLog 用 ReadBytes 逐行读取（超长行安全）。
func loadEvents(r io.Reader) ([]Event, error) {
	var events []Event
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSpace(line)
			if len(line) > 0 {
				var ev Event
				if uerr := json.Unmarshal(line, &ev); uerr != nil {
					return nil, fmt.Errorf("parse event line %q: %w", string(line), uerr)
				}
				events = append(events, ev)
			}
		}
		if err != nil {
			if err == io.EOF {
				return events, nil
			}
			return nil, err
		}
	}
}
