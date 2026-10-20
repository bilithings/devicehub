// The CLI imports this file before the compiled application starts. The full
// observability module is TypeScript and is available under .build at runtime,
// so load it opportunistically without making the Node bootstrap depend on a
// source .js file that does not exist.
let compiledObservability
try {
    compiledObservability = await import('../../.build/util/observability.js')
}
catch {
    compiledObservability = undefined
}

export function getObservationContext() {
    return compiledObservability?.getObservationContext?.() || {}
}
