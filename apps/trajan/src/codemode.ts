import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

export function workspaceCodemode(remote: () => CodemodeRemote) {
	return createCodemodeExtension({ models: false, sandbox: new RemoteCodemodeSandbox({ remote }) });
}
