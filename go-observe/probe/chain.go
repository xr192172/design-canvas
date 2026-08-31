package probe

// Package probe — P2 链路重建：从事件流的 trace 三元组（trace_id/frame_id/
// parent_id）重建跨函数调用链，供 Comparator 做链路级偏差分析。
//
// 重建算法（确定性，无启发式）：
//  1. 按 trace_id 分组（空 trace_id 的 v1 事件不参与——它们没有链路语义）
//  2. 每条链内按 frame_id 聚帧，帧的探针名 = 事件探针名去掉 scope 后缀
//     （.enter/.exit/.catch），帧起始时间 = 该帧最早事件时间
//  3. 帧按起始时间排序 → 调用序列（嵌套调用的 enter 时间随深度单调递增，
//     时间序即近似调用序；并发链路由子序列语义兜底）
//
// 链路契约（DSLDecl.Chain）用子序列语义：声明的调用序必须是某条实测链的
// 子序列。未声明的中间帧不算偏差（哑固体可只部分插桩，严格相等会假偏差风暴）。

import (
	"sort"
	"strings"
)

// scopeEventSuffixes 是 scope API 产生的事件探针名后缀。
var scopeEventSuffixes = []string{".enter", ".exit", ".catch"}

// baseProbeName 去掉 scope 事件后缀，返回帧的基础探针名。
// "svc.Handle.enter" → "svc.Handle"；无后缀原样返回。
func baseProbeName(probe string) string {
	for _, sfx := range scopeEventSuffixes {
		if strings.HasSuffix(probe, sfx) {
			return strings.TrimSuffix(probe, sfx)
		}
	}
	return probe
}

// ChainObs 是一条调用链的观测画像（ActualDSLDoc.Chains 元素）。
type ChainObs struct {
	TraceID  string   `json:"trace_id"`
	Sequence []string `json:"sequence"`       // 基础探针名调用序列（按帧起始时间）
	Errs     int      `json:"errs,omitempty"` // 链上非空 err 的事件数
	Events   int      `json:"events"`         // 链内事件总数（证据规模）
}

// 链路画像封顶：actual.dsl.json 是自包含文件，帧总量必须有界（c1 精神）。
const (
	maxChains         = 512
	maxChainFrames    = 4096 // 全部链合计帧预算
	maxSequenceExport = 128  // 单链序列导出上限（超出截断，尾部标记）
)

// RebuildChains 从事件流重建调用链画像（按链内首事件时间排序）。
// 超预算的链被丢弃（计数在返回值第二参）。
func RebuildChains(events []Event) (chains []ChainObs, dropped int) {
	// 1. trace 分组（保持事件原序）
	type chainFrame struct {
		id      uint64
		probe   string // 基础名
		start   int64  // 最早事件 UnixNano
		errs    int
		eventsN int
	}
	type chainAcc struct {
		traceID string
		frames  map[uint64]*chainFrame
		order   []uint64 // 首次出现的 frame id 序（稳定去重）
		anon    []Event  // 有 trace 无 frame id 的事件（v1 式手动传 trace）
	}

	byTrace := map[string]*chainAcc{}
	var traceOrder []string
	for _, ev := range events {
		if ev.TraceID == "" {
			continue
		}
		acc := byTrace[ev.TraceID]
		if acc == nil {
			acc = &chainAcc{traceID: ev.TraceID, frames: map[uint64]*chainFrame{}}
			byTrace[ev.TraceID] = acc
			traceOrder = append(traceOrder, ev.TraceID)
		}
		if ev.FrameID == 0 {
			acc.anon = append(acc.anon, ev)
			continue
		}
		f := acc.frames[ev.FrameID]
		if f == nil {
			f = &chainFrame{id: ev.FrameID, probe: baseProbeName(ev.Probe), start: ev.Time.UnixNano()}
			acc.frames[ev.FrameID] = f
			acc.order = append(acc.order, ev.FrameID)
		}
		f.eventsN++
		if s, _ := ev.Fields["err"].(string); s != "" {
			f.errs++
		}
	}

	// 2. 每条链：帧按起始时间排序 → 序列
	frameBudget := maxChainFrames
	for _, tid := range traceOrder {
		acc := byTrace[tid]
		if len(chains) >= maxChains || frameBudget <= 0 {
			dropped++
			continue
		}
		type fr struct {
			id    uint64
			probe string
		}
		frs := make([]fr, 0, len(acc.order))
		for _, fid := range acc.order {
			if f := acc.frames[fid]; f != nil {
				frs = append(frs, fr{f.id, f.probe})
			}
		}
		sort.SliceStable(frs, func(i, j int) bool { // 起始时间序；同刻按 frame id（首见序）
			ti, tj := acc.frames[frs[i].id].start, acc.frames[frs[j].id].start
			if ti != tj {
				return ti < tj
			}
			return frs[i].id < frs[j].id
		})

		obs := ChainObs{TraceID: tid, Sequence: make([]string, 0, len(frs)+len(acc.anon))}
		for _, f := range frs {
			obs.Sequence = append(obs.Sequence, f.probe)
			obs.Errs += acc.frames[f.id].errs
			obs.Events += acc.frames[f.id].eventsN
		}
		for _, ev := range acc.anon { // 无 frame id 的事件按原序补进序列
			obs.Sequence = append(obs.Sequence, ev.Probe)
			obs.Events++
			if s, _ := ev.Fields["err"].(string); s != "" {
				obs.Errs++
			}
		}
		if len(obs.Sequence) > maxSequenceExport {
			obs.Sequence = append(obs.Sequence[:maxSequenceExport], "…(truncated)")
		}
		frameBudget -= len(frs) + len(acc.anon)
		chains = append(chains, obs)
	}
	return chains, dropped
}

// isSubsequence 报告 want 是否为 seq 的子序列（want 各元素按序出现在 seq 中，
// 允许中间插入其他元素）。
func isSubsequence(want, seq []string) bool {
	i := 0
	for _, s := range seq {
		if i < len(want) && s == want[i] {
			i++
		}
	}
	return i == len(want)
}

// chainMatch 是一条实测链对链路契约的匹配结果。
type chainMatch struct {
	chain   ChainObs
	matched int // 子序列匹配到的最长前缀长度（诊断用：越大越接近满足）
	ok      bool
}

// matchChainDecl 在实测链集合上评估链路契约。
// 返回：satisfied（存在链满足子序列）、best（最接近的链，未满足时用于报告）。
func matchChainDecl(want []string, chains []ChainObs) (satisfied bool, best chainMatch) {
	root := want[0]
	for _, ch := range chains {
		hit := false
		for _, p := range ch.Sequence {
			if p == root {
				hit = true
				break
			}
		}
		if !hit {
			continue // 根探针未出现的链与该契约无关
		}
		m := subsequencePrefixLen(want, ch.Sequence)
		if m == len(want) {
			return true, chainMatch{chain: ch, matched: m, ok: true}
		}
		if m > best.matched {
			best = chainMatch{chain: ch, matched: m}
		}
	}
	return false, best
}

// subsequencePrefixLen 计算 want 能在 seq 中按序匹配的最长前缀长度。
func subsequencePrefixLen(want, seq []string) int {
	i := 0
	for _, s := range seq {
		if i < len(want) && s == want[i] {
			i++
		}
	}
	return i
}
