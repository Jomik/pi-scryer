# Test safety

- Automated tests must be hermetic and noninteractive: never open dialogs, request keys or credentials, or ask the user to take any action.
- Never invoke real `osascript`, native dialogs, macOS security/Keychain APIs or tools, user credential stores, `gh`, `git`, or network access during tests. No credentials may be read or mutated during test execution.
- Mock all external boundaries before loading modules under test. Subprocess and network mocks must fail closed by default: unexpected calls fail the test and must never delegate to real implementations.
- Current guards cover `node:child_process`, `child_process`, and global `fetch`; they are not a general OS or network sandbox. The hermetic rule applies to every external boundary: adding another requires extending mocks and guards before tests exercise it, never using real OS APIs or network access as a substitute.
- Unit-test native prompts, login, and cancellation through deterministic mocks only.
- If a test opens UI or touches credentials, stop the run and investigate. Never ask the user to complete the prompt or login.
