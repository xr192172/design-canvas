// observev2-record：一次真实操作的调用链录制演示（最小闭环"录制端"）。
//
// 复用 observev2-demo 的 3 层调用链（order.Place → pay.Charge → inv.Reserve），
// 开 `probe.WithRunRecorder` 把这一次操作的 enter/exit/catch 帧（含
// trace_id/frame_id/parent_id/时间/出入参/耗时）落成 <out>（runs.jsonl）。
// 产出即"插针录制一次操作"的回放素材，供 TS 重建调用树 / 前端逐步回放。
//
// 用法：go run ./cmd/observev2-record [out]   （默认 ./runs.jsonl）
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"

	"go-observe/probe"
)

func main() {
	out := "./runs.jsonl"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	tiered := probe.NewTiered(probe.WithRunRecorder(out))
	probe.SetGlobalTiered(tiered)

	// 一次真实操作：下单序 ID=42（无错误注入）
	ctx := context.Background()
	if err := placeOrder(ctx, 42, false); err != nil {
		fmt.Fprintln(os.Stderr, "操作失败:", err)
	}
	_ = tiered.Close()

	// 简述落盘内容
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	fmt.Fprintf(w, "已录制一次操作（3 层调用链）到 %s\n", out)
	fmt.Fprintf(w, "帧序列：%v\n", dataflow)
	fmt.Fprintf(w, "下一步：TS 重建调用树 → 前端逐步回放\n")
}

var dataflow []string

func mark(s string) { dataflow = append(dataflow, s) }

func placeOrder(ctx context.Context, orderID int, injectErr bool) error {
	ctx, sp := probe.Enter(ctx, "order.Place", map[string]any{"order_id": orderID})
	defer sp.Exit(map[string]any{"order_id": orderID})
	mark("Place")
	if err := chargePayment(ctx, orderID, injectErr); err != nil {
		sp.Catch(fmt.Errorf("下单失败: %w", err), map[string]any{"order_id": orderID})
		return err
	}
	return nil
}

func chargePayment(ctx context.Context, orderID int, injectErr bool) error {
	ctx, sp := probe.Enter(ctx, "pay.Charge", map[string]any{"order_id": orderID})
	defer sp.Exit(map[string]any{"order_id": orderID})
	mark("Charge")
	if err := reserveInventory(ctx, orderID, injectErr); err != nil {
		sp.Catch(fmt.Errorf("支付受阻: %w", err), nil)
		return err
	}
	return nil
}

func reserveInventory(ctx context.Context, orderID int, injectErr bool) error {
	_, sp := probe.Enter(ctx, "inv.Reserve", map[string]any{"order_id": orderID})
	defer sp.Exit(map[string]any{"order_id": orderID})
	mark("Reserve")
	if injectErr {
		err := fmt.Errorf("库存不足: sku-%d", orderID%7)
		sp.Catch(err, map[string]any{"sku": fmt.Sprintf("sku-%d", orderID%7)})
		return err
	}
	return nil
}