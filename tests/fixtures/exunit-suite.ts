/** Real ExUnit fixtures: assertion states and timings come from the VM, not canned reports. */
export function exunitSuite(mode: string): string {
	return `
defmodule WholeSuiteFormatter do
  use GenServer
  def init(_), do: {:ok, %{expected: [], observed: [], failed_modules: 0}}
  def handle_cast({:module_started, module}, state) do
    ids = Enum.map(module.tests, &{&1.module, &1.name})
    {:noreply, %{state | expected: state.expected ++ ids}}
  end
  def handle_cast({:test_finished, test}, state) do
    status = case test.state do
      nil -> "passed"
      {:skipped, _} -> "pending"
      {:excluded, _} -> "pending"
      _ -> "failed"
    end
    item = {{test.module, test.name}, %{title: Atom.to_string(test.name), status: status, duration: test.time / 1000}}
    {:noreply, %{state | observed: state.observed ++ [item]}}
  end
  def handle_cast({:module_finished, module}, state) do
    {:noreply, %{state | failed_modules: state.failed_modules + if(module.state == nil, do: 0, else: 1)}}
  end
  def handle_cast({:suite_finished, _}, state) do
    assertions = Enum.map(state.observed, &elem(&1, 1))
    ids = Enum.map(state.observed, &elem(&1, 0))
    complete = Enum.sort(ids) == Enum.sort(state.expected) and length(ids) == MapSet.size(MapSet.new(ids))
    passed = Enum.count(assertions, &(&1.status == "passed"))
    failed = Enum.count(assertions, &(&1.status == "failed"))
    pending = Enum.count(assertions, &(&1.status == "pending"))
    report = %{success: complete and failed == 0 and state.failed_modules == 0,
      numTotalTests: length(assertions), numPassedTests: passed, numFailedTests: failed,
      numPendingTests: pending, numTodoTests: 0, numFailedTestSuites: state.failed_modules,
      numPendingTestSuites: 0, testResults: [%{assertionResults: assertions}]}
    IO.puts(:json.encode(report))
    {:noreply, state}
  end
  def handle_cast(_, state), do: {:noreply, state}
end
File.write!(".treeseed/order", "suite\\n", [:append])
${mode === 'mixed' ? 'IO.puts("private native output")' : ''}
${mode === 'missing' ? 'System.halt(0)' : ''}
${mode === 'truncated' ? 'IO.write("{\\\"success\\\":"); System.halt(0)' : ''}
ExUnit.start(formatters: [WholeSuiteFormatter]${mode === 'excluded' ? ', exclude: [selected: true]' : ''})
${mode === 'empty' ? '' : `
defmodule NativeWholeSuiteTest do
  use ExUnit.Case
  test "unit assertion" do
    assert 2 + 2 == 4
  end
  ${mode === 'skip' ? '@tag :skip' : mode === 'excluded' ? '@tag selected: true' : ''}
  test "real process integration" do
    parent = self()
    spawn(fn -> send(parent, {:observed, 4}) end)
    assert_receive {:observed, 4}
    ${mode === 'failure' ? 'assert false, "private native error"' : ''}
    ${mode === 'mutation' ? 'File.write!("candidate.ts", "changed source")' : ''}
  end
end`}
`;
}
