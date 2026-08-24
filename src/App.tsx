import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapResponse,
  CallSnapshot,
  ClientMessage,
  DemoScenario,
  ScenarioEvaluationResult,
  ServerEvent,
} from "./shared/contracts.js";
import { MicrophoneCapture, playBase64Audio, speakWithBrowser } from "./lib/audio.js";

interface Notice {
  id: number;
  level: "info" | "warning" | "error";
  message: string;
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

const formatMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

const labelForState = (state: string) => state.replaceAll("_", " ");

const formatLatency = (value: number | undefined) =>
  typeof value === "number" ? `${value.toLocaleString()} ms` : "—";

const narrationProvenanceLabel = (renderedBy: "model" | "fixture" | "template") => {
  if (renderedBy === "model") return "Live model · verified";
  if (renderedBy === "fixture") return "Replayed model fixture · verified";
  return "Template fallback";
};

const livePromptSuggestions = [
  "My confirmation is MPT 4821 — last name Lee.",
  "Could we move the stay to October 20th through the 24th?",
  "I was charged twice after cancelling, and I need to dispute it.",
];

const scenarioCardLabel = (scenarioId: string) => {
  if (scenarioId === "happy_exact") return "Move a Lisbon stay";
  if (scenarioId === "happy_correction") return "Correct dates";
  if (scenarioId === "payment_penalty") return "Charge dispute";
  if (scenarioId === "urgent_disruption") return "Stranded tonight";
  return "Identity verification";
};

const scenarioGoalLabel = (scenarioId: string) => {
  if (scenarioId === "happy_exact") return "Change dates and choose an option";
  if (scenarioId === "happy_correction") return "Correct invalid dates and choose an option";
  if (scenarioId === "payment_penalty") return "Escalate a disputed cancellation charge";
  if (scenarioId === "urgent_disruption") return "Escalate an urgent hotel closure";
  return "Escalate when identity cannot be verified";
};

const toolActivityLabel = (action: "find" | "quote_date_change" | "confirm_date_change") => {
  if (action === "find") return "Reservation lookup";
  if (action === "quote_date_change") return "Replacement options quoted";
  return "Date change confirmed";
};

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span>M</span>
      <i />
      <span>P</span>
    </div>
  );
}

function Waveform({ active }: { active: boolean }) {
  return (
    <div className={`waveform ${active ? "waveform--active" : ""}`} aria-hidden="true">
      {Array.from({ length: 28 }, (_, index) => (
        <span key={index} style={{ animationDelay: `${(index % 7) * -90}ms` }} />
      ))}
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [snapshot, setSnapshot] = useState<CallSnapshot>();
  const [selectedScenarioId, setSelectedScenarioId] = useState("happy_exact");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [evalResults, setEvalResults] = useState<Record<string, ScenarioEvaluationResult>>({});
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteTotal, setSuiteTotal] = useState(5);
  const [typedTurn, setTypedTurn] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("MPT-4821");
  const [lastName, setLastName] = useState("Lee");
  const [checkIn, setCheckIn] = useState("2027-10-20");
  const [checkOut, setCheckOut] = useState("2027-10-24");
  const [socketReady, setSocketReady] = useState(false);
  const [micError, setMicError] = useState<string>();
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const snapshotRef = useRef<CallSnapshot | undefined>(undefined);
  const microphoneRef = useRef(new MicrophoneCapture());
  const playbackDepth = useRef(0);
  const suiteRunningRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const addNotice = (level: Notice["level"], message: string) => {
    setNotices((current) => [...current.slice(-2), { id: Date.now() + Math.random(), level, message }]);
  };

  useEffect(() => {
    const controller = new AbortController();
    let socket: WebSocket | undefined;
    const connect = async () => {
      const response = await fetch("/api/bootstrap", { method: "POST", signal: controller.signal });
      if (!response.ok) throw new Error("Could not initialize the demo session.");
      const data = (await response.json()) as BootstrapResponse;
      if (controller.signal.aborted) return;
      setBootstrap(data);
      setSnapshot(data.snapshot);
      snapshotRef.current = data.snapshot;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(data.sessionId)}`);
      socketRef.current = socket;
      socket.onopen = () => setSocketReady(true);
      socket.onclose = () => setSocketReady(false);
      socket.onerror = () => addNotice("error", "The live event connection could not be established.");
      socket.onmessage = (messageEvent) => handleServerEvent(JSON.parse(messageEvent.data) as ServerEvent);
    };
    void connect().catch((error: unknown) => {
      if (!controller.signal.aborted) addNotice("error", error instanceof Error ? error.message : "Demo initialization failed.");
    });
    return () => {
      controller.abort();
      socket?.close();
      microphoneRef.current.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (snapshot?.outcome) microphoneRef.current.stop();
  }, [snapshot?.transcript.length, snapshot?.partialTranscript, snapshot?.outcome]);

  const handleServerEvent = (event: ServerEvent) => {
    if (event.type === "snapshot" || event.type === "session.ready") {
      snapshotRef.current = event.snapshot;
      setSnapshot(event.snapshot);
      return;
    }
    if (event.type === "notice") {
      addNotice(event.level, event.message);
      return;
    }
    if (
      event.type === "transcript.final" &&
      snapshotRef.current?.mode === "playback" &&
      event.turn.role === "caller" &&
      !suiteRunningRef.current
    ) {
      playbackDepth.current += 1;
      speakWithBrowser(event.turn.text, "caller", () => {
        playbackDepth.current = Math.max(0, playbackDepth.current - 1);
      });
      return;
    }
    if (event.type === "agent.message") {
      if (suiteRunningRef.current) return;
      playbackDepth.current += 1;
      const done = () => {
        playbackDepth.current = Math.max(0, playbackDepth.current - 1);
      };
      if (event.audioBase64) {
        void playBase64Audio(event.audioBase64, event.audioMimeType, done);
      } else {
        speakWithBrowser(event.turn.text, "agent", done);
      }
      return;
    }
    if (event.type === "scenario.complete") {
      setEvalResults((current) => ({ ...current, [event.scenarioId]: event }));
      return;
    }
    if (event.type === "scenario.suite.started") {
      suiteRunningRef.current = true;
      setSuiteRunning(true);
      setSuiteTotal(event.total);
      return;
    }
    if (event.type === "scenario.suite.complete") {
      suiteRunningRef.current = false;
      setSuiteRunning(false);
      setEvalResults(Object.fromEntries(event.results.map((result) => [result.scenarioId, result])));
    }
  };

  const send = (message: ClientMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      addNotice("error", "The demo connection is not ready yet.");
      return;
    }
    socketRef.current.send(JSON.stringify(message));
  };

  const scenarios = bootstrap?.scenarios ?? [];
  const selectedScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? scenarios[0],
    [scenarios, selectedScenarioId],
  );
  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === snapshot?.scenarioId) ?? selectedScenario,
    [scenarios, selectedScenario, snapshot?.scenarioId],
  );
  const callActive = Boolean(snapshot?.callId && !snapshot.outcome);
  const liveCallActive = callActive && snapshot?.mode === "live";
  const evaluationActive = suiteRunning || (callActive && snapshot?.mode === "playback");
  const interpretationMetric =
    snapshot?.metrics.interpretationBy === "model"
      ? `Model · ${formatLatency(snapshot.metrics.llmMs)}`
      : snapshot?.metrics.interpretationBy === "deterministic"
        ? "Deterministic parser"
        : "—";
  const languageMetric =
    snapshot?.metrics.narrationBy === "model"
      ? `Model · ${formatLatency(snapshot.metrics.narrationMs)}`
      : snapshot?.metrics.narrationBy === "fixture"
        ? "Replayed model fixture"
        : snapshot?.metrics.narrationBy === "template"
          ? "Template fallback"
          : "—";
  const callStarted = Boolean(snapshot?.callId);
  const agentActivity = [
    ...(snapshot?.toolCalls.map((tool) => ({
      id: tool.id,
      label: toolActivityLabel(tool.action),
      detail: `${tool.status}${tool.durationMs ? ` · ${tool.durationMs} ms` : ""}`,
      status: tool.status,
    })) ?? []),
    ...(snapshot?.handoffSummary
      ? [{
          id: "simulated-handoff",
          label: "Simulated handoff prepared",
          detail: "No external queue or human contacted",
          status: "success" as const,
        }]
      : []),
  ];
  const currentEvalResult = snapshot ? evalResults[snapshot.scenarioId] : undefined;
  const completedEvaluations = Object.values(evalResults);
  const passedEvaluations = completedEvaluations.filter((result) => result.passed).length;

  const prepareScenario = (scenario: DemoScenario) => {
    setSelectedScenarioId(scenario.id);
    setConfirmationCode(scenario.confirmationCode);
    setLastName(scenario.lastName);
    setCheckIn(scenario.id === "happy_correction" ? "2027-11-11" : "2027-10-20");
    setCheckOut(scenario.id === "happy_correction" ? "2027-11-15" : "2027-10-24");
  };

  const startLiveCall = async () => {
    if (!snapshot?.aiAvailable || callActive || suiteRunning) return;
    setMicError(undefined);
    try {
      await microphoneRef.current.start((audio) => {
        const current = snapshotRef.current;
        if (current?.mode === "live" && current.voiceMode === "listening" && playbackDepth.current === 0) {
          send({ type: "audio.chunk", audio });
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Microphone permission was denied.";
      setMicError(message);
      addNotice("warning", "Microphone unavailable. You can still use typed turns and editable recovery fields.");
    }
    send({ type: "call.start", scenarioId: "live_exploration", mode: "live" });
  };

  const runScenario = (scenario: DemoScenario) => {
    if (callActive || suiteRunning) return;
    prepareScenario(scenario);
    suiteRunningRef.current = false;
    send({ type: "scenario.play", scenarioId: scenario.id });
  };

  const runScenarioSuite = () => {
    if (callActive || suiteRunning) return;
    setEvalResults({});
    suiteRunningRef.current = true;
    setSuiteRunning(true);
    send({ type: "scenario.suite.play" });
  };

  const endDemo = () => {
    microphoneRef.current.stop();
    window.speechSynthesis?.cancel();
    playbackDepth.current = 0;
    send({ type: "call.end" });
  };

  const resetDemo = () => {
    microphoneRef.current.stop();
    window.speechSynthesis?.cancel();
    playbackDepth.current = 0;
    suiteRunningRef.current = false;
    setSuiteRunning(false);
    setEvalResults({});
    send({ type: "session.reset", scenarioId: selectedScenarioId });
  };

  const submitTypedTurn = (event: FormEvent) => {
    event.preventDefault();
    const text = typedTurn.trim();
    if (!text || !callActive) return;
    send({ type: "text.turn", text });
    setTypedTurn("");
  };

  const exportSession = () => {
    if (!bootstrap) return;
    window.location.assign(`/api/sessions/${encodeURIComponent(bootstrap.sessionId)}/export`);
  };

  if (!bootstrap || !snapshot || !selectedScenario || !activeScenario) {
    return (
      <main className="loading-screen">
        <BrandMark />
        <p>Preparing the synthetic travel desk…</p>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <strong>Meridian & Pine</strong>
            <span>Travel intelligence studio</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`connection ${socketReady ? "connection--ready" : ""}`}>
            <i /> {socketReady ? "Demo ready" : "Connecting"}
          </span>
          <button className="text-button" onClick={exportSession}>Export trace</button>
          <button className="text-button" onClick={resetDemo}>Reset demo</button>
        </div>
      </header>

      <div className="disclosure" role="note">
        <strong>Fictional AI demo</strong>
        <span>All people, reservations, prices, and actions are synthetic. Never enter real travel or payment details.</span>
      </div>

      <main>
        <section className="intro intro--compact intro--live">
          <div>
            <p className="eyebrow">Voice agent portfolio</p>
            <h1>Talk to a live voice agent. <em>Inspect every guarded action.</em></h1>
          </div>
          <ol className="flow-steps" aria-label="Demo flow">
            <li>Speak or type</li>
            <li>Model interprets</li>
            <li>Workflow decides</li>
            <li>Trace verifies</li>
          </ol>
        </section>

        <section className="live-launch" aria-labelledby="live-heading">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2 id="live-heading">Start a live call</h2>
            </div>
            <span className={`live-readiness ${snapshot.aiAvailable ? "live-readiness--ready" : ""}`}>
              <i /> {snapshot.aiAvailable ? "Live models configured" : "API key required"}
            </span>
          </div>
          <div className="live-launch-grid">
            <div className="live-call-control">
              <span className="live-kicker">Natural conversation · guarded execution</span>
              <h2>Speak naturally. The model handles language; deterministic code controls actions.</h2>
              <p>
                Use the microphone or type any caller wording. Paraphrases, corrections, and unsupported requests
                still pass through policy and the server-owned workflow before any mock tool can run.
              </p>
              <div className="sandbox-identities">
                <span>Synthetic test identities</span>
                <code>MPT-4821 · Lee</code>
                <code>MPT-7315 · Patel</code>
              </div>
              <div className="live-primary-actions">
                {liveCallActive ? (
                  <button className="end-button live-call-button" onClick={endDemo}>End live call</button>
                ) : (
                  <button
                    className="primary-button live-call-button"
                    onClick={() => void startLiveCall()}
                    disabled={!socketReady || !snapshot.aiAvailable || evaluationActive}
                    title={snapshot.liveAvailabilityReason}
                  >
                    <span className="button-dot" /> Start live call
                  </button>
                )}
                <small>
                  {snapshot.aiAvailable
                    ? "Uses live STT, model interpretation, verified model narration, and TTS."
                    : "Configure OPENAI_API_KEY to enable live interpretation, narration, speech, and synthesis."}
                </small>
              </div>
            </div>
            <div className="live-prompt-panel">
              <div>
                <span>Try saying—or rewrite—one of these</span>
                <small>Examples only. Speak or type any wording.</small>
              </div>
              <div className="prompt-suggestions">
                {livePromptSuggestions.map((prompt) => (
                  <button type="button" key={prompt} onClick={() => setTypedTurn(prompt)}>{prompt}</button>
                ))}
              </div>
              <form className="live-composer" onSubmit={submitTypedTurn}>
                <label htmlFor="typed-turn">Typed caller language</label>
                <div>
                  <input
                    id="typed-turn"
                    value={typedTurn}
                    onChange={(event) => setTypedTurn(event.target.value)}
                    placeholder="Type any caller wording, then start a live call"
                  />
                  <button disabled={!liveCallActive || !typedTurn.trim()}>Send</button>
                </div>
              </form>
              {micError && <p className="inline-error">Microphone: {micError}</p>}
            </div>
          </div>
        </section>

        <section className="demo-grid demo-grid--focused">
          <article className="call-stage call-stage--focused">
            <div className="panel-heading">
              <div>
                <span className="step-number">02</span>
                <h2>Call demo</h2>
              </div>
              <span className={`mode-badge mode-badge--${snapshot.mode}`}>
                {snapshot.mode === "live" ? "Live AI" : "Replayed scenario"}
              </span>
            </div>

            <div className={`call-status call-status--${snapshot.voiceMode}`}>
              <span className="call-status-dot" aria-hidden="true" />
              <div>
                <small>{callActive ? labelForState(snapshot.voiceMode) : snapshot.outcome ? "Call complete" : "Ready to run"}</small>
                <strong>{callActive || snapshot.outcome ? labelForState(snapshot.state) : "Live exploration"}</strong>
              </div>
              <Waveform active={callActive && ["listening", "speaking", "processing"].includes(snapshot.voiceMode)} />
            </div>

            <div className="scenario-brief scenario-brief--focused">
              <span>{snapshot.mode === "live" ? "Live sandbox" : "Replayed caller"}</span>
              <strong>{snapshot.mode === "live" ? "Freeform synthetic caller" : activeScenario.persona}</strong>
              <p>
                {snapshot.mode === "live"
                  ? "Use either synthetic identity and speak or type naturally. Suggested prompts are optional."
                  : activeScenario.goal}
              </p>
              <dl>
                <div><dt>Code</dt><dd>{snapshot.mode === "live" ? "MPT-4821" : activeScenario.confirmationCode}</dd></div>
                <div><dt>Last name</dt><dd>{snapshot.mode === "live" ? "Lee" : activeScenario.lastName}</dd></div>
              </dl>
            </div>

            {liveCallActive && (
              <div className="recovery-grid">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    send({ type: "identity.correct", confirmationCode, lastName });
                  }}
                >
                  <span>Recognition repair</span>
                  <label>Confirmation code<input value={confirmationCode} onChange={(event) => setConfirmationCode(event.target.value)} /></label>
                  <label>Last name<input value={lastName} onChange={(event) => setLastName(event.target.value)} /></label>
                  <button>Apply identity</button>
                </form>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    send({ type: "dates.correct", checkIn, checkOut });
                  }}
                >
                  <span>Date repair</span>
                  <label>Check-in<input type="date" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label>
                  <label>Check-out<input type="date" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label>
                  <button>Apply dates</button>
                </form>
              </div>
            )}

            {snapshot.options.length > 0 && (
              <div className="option-stack">
                <div className="subheading"><span>Mock availability</span><small>Say first, second, or third</small></div>
                {snapshot.options.map((option, index) => (
                  <div className={`option-row ${snapshot.selectedOption?.optionId === option.optionId ? "option-row--selected" : ""}`} key={option.optionId}>
                    <span>0{index + 1}</span>
                    <div><strong>{option.label}</strong><small>{formatDate(option.checkIn)} — {formatDate(option.checkOut)} · {option.roomType}</small></div>
                    <b className={option.priceDeltaCents < 0 ? "saving" : ""}>
                      {option.priceDeltaCents >= 0 ? "+" : "−"}{formatMoney(Math.abs(option.priceDeltaCents))}
                    </b>
                  </div>
                ))}
              </div>
            )}

          </article>

          <aside className="operations-panel operations-panel--focused">
            <div className="panel-heading">
              <div>
                <span className="step-number">03</span>
                <h2>Agent trace</h2>
              </div>
              <span className="state-chip">{labelForState(snapshot.state)}</span>
            </div>

            {notices.length > 0 && (
              <div className="notice-stack">
                {notices.map((notice) => <div key={notice.id} className={`notice notice--${notice.level}`}><span>{notice.message}</span><button onClick={() => setNotices((items) => items.filter((item) => item.id !== notice.id))}>×</button></div>)}
              </div>
            )}

            {(snapshot.outcome || currentEvalResult) && (
              <section className={`outcome-card outcome-card--prominent ${snapshot.outcome === "changed" || currentEvalResult?.passed ? "outcome-card--success" : ""}`}>
                <span><b className="step-number">04</b> Final call outcome</span>
                <h3>{snapshot.outcome ? labelForState(snapshot.outcome) : "Evaluation complete"}</h3>
                {currentEvalResult && <p className="outcome-summary">Replayed scenario evaluation {currentEvalResult.passed ? "passed" : "needs review"}.</p>}
              </section>
            )}

            <section className="ops-section transcript-section">
              <div className="subheading"><span>Transcript</span><small>Session only · never stored</small></div>
              <div className="transcript" aria-live="polite">
                {snapshot.transcript.length === 0 && <p className="empty-state">Run the demo to watch the call unfold here.</p>}
                {snapshot.transcript.map((turn) => (
                  <div className={`turn turn--${turn.role}`} key={turn.id}>
                    <div className="turn-header">
                      <span className="turn-speaker">{turn.role === "caller" ? snapshot.mode === "live" ? "Caller" : activeScenario.persona.split(" ")[0] : turn.role === "agent" ? "AI agent" : "System"}</span>
                      {turn.narration && (
                        <span
                          className={`narration-provenance narration-provenance--${turn.narration.renderedBy}`}
                          data-testid="narration-provenance"
                          title={`${turn.narration.intent}${turn.narration.model ? ` · ${turn.narration.model}` : ""}${turn.narration.fallbackReason ? ` · ${turn.narration.fallbackReason}` : ""}`}
                        >
                          {narrationProvenanceLabel(turn.narration.renderedBy)}
                        </span>
                      )}
                      <time>{new Date(turn.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                    </div>
                    <p>{turn.text}</p>
                    {turn.narration?.fidelity.status === "rejected" && (
                      <small className="narration-detail">
                        Candidate rejected by fact-fidelity verification · verified template shown
                      </small>
                    )}
                  </div>
                ))}
                {snapshot.partialTranscript && <div className="turn turn--caller turn--partial"><div className="turn-header"><span className="turn-speaker">Listening</span></div><p>{snapshot.partialTranscript}<i /></p></div>}
                <div ref={transcriptEndRef} />
              </div>
            </section>

            <section className="ops-section activity-section">
              <div className="subheading"><span>Agent activity</span><small>High-level actions</small></div>
              <div className="activity-list">
                {agentActivity.length === 0 && <p className="empty-state">No activity yet.</p>}
                {agentActivity.map((item) => (
                  <div className="activity-row" key={item.id}>
                    <span className={`tool-status tool-status--${item.status}`} />
                    <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                  </div>
                ))}
              </div>
            </section>

            {snapshot.handoffSummary && (
              <section className="handoff-card">
                <span>Simulated human handoff</span>
                <h3>{snapshot.handoffSummary.queueLabel}</h3>
                <div>{snapshot.handoffSummary.reasons.map((reason) => <b key={reason}>{labelForState(reason)}</b>)}</div>
                <p>{snapshot.handoffSummary.requestSummary}</p>
                <small>No external queue or human was contacted.</small>
              </section>
            )}

            {callStarted && (
              <details className="technical-details">
                <summary>
                  <div><strong>Technical details</strong><small>{snapshot.toolCalls.length} tools · {languageMetric}</small></div>
                  <span>Expand</span>
                </summary>
                <section className="ops-section">
                  <div className="subheading"><span>Latency & provenance</span><small>Latest turn · source + timing</small></div>
                  <div className="metrics-grid">
                    {[
                      ["Interpretation", interpretationMetric],
                      ["Language", languageMetric],
                      ["STT final", formatLatency(snapshot.metrics.sttFinalMs)],
                      ["Tool", formatLatency(snapshot.metrics.toolMs)],
                      ["TTS", formatLatency(snapshot.metrics.ttsMs)],
                      ["Turn total", formatLatency(snapshot.metrics.turnTotalMs)],
                    ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
                  </div>
                </section>
                <section className="ops-section">
                  <div className="subheading"><span>Raw tool calls</span><small>{snapshot.toolCalls.length} recorded</small></div>
                  <div className="tool-stack">
                    {snapshot.toolCalls.length === 0 && <p className="empty-state">No reservation tools have been called.</p>}
                    {snapshot.toolCalls.map((tool) => (
                      <details className="tool-row" key={tool.id}>
                        <summary>
                          <span className={`tool-status tool-status--${tool.status}`} />
                          <div><strong>{tool.name}</strong><small>{tool.action}</small></div>
                          <b>{tool.durationMs ? `${tool.durationMs} ms` : "running"}</b>
                        </summary>
                        <div className="tool-payload"><span>Arguments</span><pre>{JSON.stringify(tool.arguments, null, 2)}</pre>{tool.result && <><span>Result</span><pre>{JSON.stringify(tool.result, null, 2)}</pre></>}</div>
                      </details>
                    ))}
                  </div>
                </section>
                {currentEvalResult && (
                  <section className="ops-section">
                    <div className="subheading"><span>Evaluation checks</span><small>{currentEvalResult.passed ? "Passed" : "Review needed"}</small></div>
                    <div className="assertions">{currentEvalResult.assertions.map((assertion) => <p key={assertion} className={assertion.startsWith("PASS") ? "pass" : "fail"}>{assertion}</p>)}</div>
                  </section>
                )}
                {snapshot.history.length > 0 && (
                  <section className="ops-section">
                    <div className="subheading"><span>Session history</span><small>Cleared on reset</small></div>
                    <div className="history-list">
                      {snapshot.history.map((item) => <div key={item.callId}><span className={`history-dot history-dot--${item.outcome}`} /><div><strong>{labelForState(item.outcome)}</strong><small>{item.mode} · {item.toolCount} tools · {(item.durationMs / 1000).toFixed(1)}s</small></div></div>)}
                    </div>
                  </section>
                )}
              </details>
            )}
          </aside>
        </section>

        <section className="evaluation-suite" aria-labelledby="suite-heading">
          <div className="suite-heading">
            <div>
              <span className="suite-label">Evaluation &amp; fallback</span>
              <h2 id="suite-heading">Run verified scenarios</h2>
              <p>
                Replays five scripted calls through the same policy, workflow, mock tool, and verifier.
                Fixture-generated language is replayed and re-verified—it is not live AI.
              </p>
            </div>
            <div className="suite-actions">
              <div className="suite-progress" aria-live="polite">
                <strong>{suiteRunning ? `${completedEvaluations.length} of ${suiteTotal}` : `${passedEvaluations} of ${completedEvaluations.length || 5}`}</strong>
                <span>{suiteRunning ? "scenarios complete" : completedEvaluations.length ? "passed" : "not run"}</span>
              </div>
              <button
                className="secondary-button suite-run-all"
                onClick={runScenarioSuite}
                disabled={!socketReady || callActive || suiteRunning}
              >
                {suiteRunning ? "Running suite…" : "Run all five"}
              </button>
            </div>
          </div>

          <div className="scenario-score-grid">
            {scenarios.map((scenario, index) => {
              const result = evalResults[scenario.id];
              const running = evaluationActive && snapshot.scenarioId === scenario.id && !snapshot.outcome;
              return (
                <article className={`scenario-score-card ${result?.passed ? "scenario-score-card--passed" : ""}`} key={scenario.id}>
                  <div className="scenario-score-header">
                    <span>0{index + 1}</span>
                    <b className={result ? result.passed ? "pass" : "fail" : running ? "running" : "idle"}>
                      {result ? result.passed ? "Passed" : "Failed" : running ? "Running" : "Not run"}
                    </b>
                  </div>
                  <h3>{scenarioCardLabel(scenario.id)}</h3>
                  <p>{scenarioGoalLabel(scenario.id)}</p>
                  <small>Expected: {labelForState(scenario.expectedOutcome)}</small>
                  {result && (
                    <div className="scenario-score-result">
                      <span>Actual: {result.actualOutcome ? labelForState(result.actualOutcome) : "none"}</span>
                      <span>{result.toolCount} tools</span>
                      <span>{result.narrationSources.fixture} replayed</span>
                      <span>{result.narrationSources.template} fallbacks</span>
                    </div>
                  )}
                  <button
                    className="scenario-run-button"
                    onClick={() => runScenario(scenario)}
                    disabled={!socketReady || callActive || suiteRunning}
                  >
                    Run scenario
                  </button>
                  {result && (
                    <details className="scenario-assertions">
                      <summary>Scorecard details</summary>
                      {result.assertions.map((assertion) => (
                        <p key={assertion} className={assertion.startsWith("PASS") ? "pass" : "fail"}>{assertion}</p>
                      ))}
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <footer>
        <span>Meridian & Pine · fictional portfolio case study</span>
        <span>Browser → STT → deterministic policy → verified language → mock tool → TTS</span>
      </footer>
    </div>
  );
}
