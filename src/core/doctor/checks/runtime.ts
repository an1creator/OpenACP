import type { CheckResult, DoctorCheck } from '../types.js'
import { evaluateNodeRuntime, nodeRuntimeMessage } from '../../utils/node-runtime.js'

/** Build the doctor result for a specific Node.js version. */
export function checkNodeRuntime(version = process.versions.node): CheckResult {
  return {
    status: evaluateNodeRuntime(version).supported ? 'pass' : 'fail',
    message: nodeRuntimeMessage(version),
  }
}

/** Verify that the host runtime meets the product support boundary. */
export const runtimeCheck: DoctorCheck = {
  name: 'Runtime',
  order: 0,
  async run() {
    return [checkNodeRuntime()]
  },
}
