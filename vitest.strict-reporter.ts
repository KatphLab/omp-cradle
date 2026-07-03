import type { Reporter, TestModule } from 'vitest/node'

const countSkippedAndTodoTests = (testModules: readonly TestModule[]) => {
  let skippedCount = 0
  let todoCount = 0

  for (const testModule of testModules) {
    for (const testCase of testModule.children.allTests('skipped')) {
      if (testCase.options.mode === 'todo') {
        todoCount += 1
      } else {
        skippedCount += 1
      }
    }
  }

  return { skippedCount, todoCount }
}

export const strictReporter: Reporter = {
  onTestRunEnd(testModules) {
    const { skippedCount, todoCount } = countSkippedAndTodoTests(testModules)

    if (skippedCount === 0 && todoCount === 0) {
      return
    }

    throw new Error(
      `Strict Vitest policy violation: found ${skippedCount} skipped test(s) and ${todoCount} todo test(s). Remove skip/todo markers before merging.`,
    )
  },
}
