import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapResponse,
  CallSnapshot,
  ClientMessage,
  DemoMode,
  DemoScenario,
  ServerEvent,
} from "./shared/contracts.js";
import { MicrophoneCapture, playBase64Audio, speakWithBrowser } from "./lib/audio.js";

interface Notice {
  id: number;
  level: "info" | "warning" | "error";
  message: string;
}

interface EvalResult {
  scenarioId: string;
  passed: boolean;
  assertions: string[];
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
  if (renderedBy === "fixture") return "Model fixture · verified";
  return "Template fallback";
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
  const [mode, setMode] = useState<DemoMode>("playback");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [evalResult, setEvalResult] = useState<EvalResult>();
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
      setMode(data.snapshot.aiAvailable ? "live" : "playback");
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
    if (event.type === "transcript.final" && snapshotRef.current?.mode === "playback" && event.turn.role === "caller") {
      playbackDepth.current += 1;
      speakWithBrowser(event.turn.text, "caller", () => {
        playbackDepth.current = Math.max(0, playbackDepth.current - 1);
      });
      return;
    }
    if (event.type === "agent.message") {
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
      setEvalResult({ scenarioId: event.scenarioId, passed: event.passed, assertions: event.assertions });
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
  const callActive = Boolean(snapshot?.callId && !snapshot.outcome);
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
        ? "Verified model fixture"
        : snapshot?.metrics.narrationBy === "template"
          ? "Template fallback"
          : "—";

  const selectScenario = (scenario: DemoScenario) => {
    if (callActive) return;
    setSelectedScenarioId(scenario.id);
    setConfirmationCode(scenario.confirmationCode);
    setLastName(scenario.lastName);
    setCheckIn(scenario.id === "happy_correction" ? "2027-11-11" : "2027-10-20");
    setCheckOut(scenario.id === "happy_correction" ? "2027-11-15" : "2027-10-24");
    setEvalResult(undefined);
  };

  const startDemo = async () => {
    if (!selectedScenario || callActive) return;
    setEvalResult(undefined);
    setMicError(undefined);
    if (mode === "playback") {
      send({ type: "scenario.play", scenarioId: selectedScenario.id });
      return;
    }
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
    send({ type: "call.start", scenarioId: selectedScenario.id, mode: "live" });
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
    setEvalResult(undefined);
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

  if (!bootstrap || !snapshot || !selectedScenario) {
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
            <i /> {socketReady ? "Operations online" : "Connecting"}
          </span>
          <button className="text-button" onClick={exportSession}>Export trace</button>
          <button className="text-button" onClick={resetDemo}>Reset demo</button>
        </div>
      </header>

      <div className="disclosure" role="note">
        <strong>Fictional AI demonstration</strong>
        <span>All travelers, reservations, options, prices, handoffs, and confirmations are synthetic. Never enter real travel or payment details.</span>
      </div>

      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">Inbound itinerary support · Vertical 01</p>
            <h1>A travel call you can <em>see thinking.</em></h1>
          </div>
          <p className="intro-copy">
            Speak naturally while deterministic policy controls every decision, a model phrases verified facts, and the interface exposes every operational step.
          </p>
        </section>

        <section className="scenario-section" aria-labelledby="scenario-heading">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2 id="scenario-heading">Choose a call</h2>
            </div>
            <span>One is ready to go</span>
          </div>
          <div className="scenario-grid">
            {scenarios.map((scenario, index) => (
              <button
                className={`scenario-card ${scenario.id === selectedScenarioId ? "scenario-card--selected" : ""}`}
                key={scenario.id}
                onClick={() => selectScenario(scenario)}
                disabled={callActive}
              >
                <span className="scenario-index">0{index + 1}</span>
                <span className="scenario-accent">{scenario.accent}</span>
                <strong>{scenario.title}</strong>
                <small>{scenario.persona} · {scenario.confirmationCode}</small>
                <i aria-hidden="true">{scenario.id === selectedScenarioId ? "Selected" : "Explore"}</i>
              </button>
            ))}
          </div>
        </section>

        <section className="demo-grid">
          <article className="call-stage">
            <div className="panel-heading">
              <div>
                <span className="step-number">02</span>
                <h2>Conversation</h2>
              </div>
              <span className={`mode-badge mode-badge--${snapshot.mode}`}>{snapshot.mode === "live" ? "Live AI" : "Scenario playback"}</span>
            </div>

            <div className="mode-switch" aria-label="Demo mode">
              <button
                className={mode === "live" ? "active" : ""}
                onClick={() => setMode("live")}
                disabled={!snapshot.aiAvailable || callActive}
                title={snapshot.liveAvailabilityReason}
              >
                <span>Live AI</span>
                <small>{snapshot.aiAvailable ? "Microphone + hosted models" : "API key required"}</small>
              </button>
              <button className={mode === "playback" ? "active" : ""} onClick={() => setMode("playback")} disabled={callActive}>
                <span>Scenario Playback</span>
                <small>Recorded model language · deterministic replay</small>
              </button>
            </div>

            <div className={`call-orb call-orb--${snapshot.voiceMode}`}>
              <div className="orb-ring orb-ring--outer" />
              <div className="orb-ring orb-ring--inner" />
              <div className="orb-core">
                <span>{callActive ? labelForState(snapshot.voiceMode) : "ready"}</span>
                <strong>{callActive ? labelForState(snapshot.state) : selectedScenario.shortLabel}</strong>
              </div>
            </div>
            <Waveform active={callActive && ["listening", "speaking", "processing"].includes(snapshot.voiceMode)} />

            <div className="scenario-brief">
              <span>Caller brief</span>
              <strong>{selectedScenario.persona}</strong>
              <p>{selectedScenario.goal}</p>
              <dl>
                <div><dt>Code</dt><dd>{selectedScenario.confirmationCode}</dd></div>
                <div><dt>Last name</dt><dd>{selectedScenario.lastName}</dd></div>
              </dl>
            </div>

            <div className="call-actions">
              {!callActive ? (
                <button className="primary-button" onClick={() => void startDemo()} disabled={!socketReady}>
                  <span className="button-dot" /> Start demo
                </button>
              ) : (
                <button className="end-button" onClick={endDemo}>End call</button>
              )}
              <span>{mode === "live" ? "Allow microphone access, then speak when the orb says listening." : "Replays the full scripted call and scores the result."}</span>
            </div>
            {micError && <p className="inline-error">Microphone: {micError}</p>}

            {callActive && (
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

            <form className="typed-turn" onSubmit={submitTypedTurn}>
              <label htmlFor="typed-turn">Typed recovery</label>
              <div><input id="typed-turn" value={typedTurn} onChange={(event) => setTypedTurn(event.target.value)} placeholder="Type a caller turn when audio is unavailable" disabled={!callActive} /><button disabled={!callActive || !typedTurn.trim()}>Send</button></div>
            </form>
          </article>

          <aside className="operations-panel">
            <div className="panel-heading">
              <div>
                <span className="step-number">03</span>
                <h2>Live operations</h2>
              </div>
              <span className="state-chip">{labelForState(snapshot.state)}</span>
            </div>

            {notices.length > 0 && (
              <div className="notice-stack">
                {notices.map((notice) => <div key={notice.id} className={`notice notice--${notice.level}`}><span>{notice.message}</span><button onClick={() => setNotices((items) => items.filter((item) => item.id !== notice.id))}>×</button></div>)}
              </div>
            )}

            <section className="ops-section transcript-section">
              <div className="subheading"><span>Live transcript</span><small>Session only · never stored</small></div>
              <div className="transcript" aria-live="polite">
                {snapshot.transcript.length === 0 && <p className="empty-state">The transcript will appear here as the call unfolds.</p>}
                {snapshot.transcript.map((turn) => (
                  <div className={`turn turn--${turn.role}`} key={turn.id}>
                    <div className="turn-header">
                      <span className="turn-speaker">{turn.role === "caller" ? selectedScenario.persona.split(" ")[0] : turn.role === "agent" ? "AI agent" : "System"}</span>
                      {turn.narration && (
                        <span
                          className={`narration-provenance narration-provenance--${turn.narration.renderedBy}`}
                          data-testid="narration-provenance"
                          title={`${turn.narration.intent}${turn.narration.model ? ` · ${turn.narration.model}` : ""}${turn.narration.fallbackReason ? ` · ${turn.narration.fallbackReason}` : ""}`}
                        >
                          {narrationProvenanceLabel(turn.narration.renderedBy)}
                        </span>
                      )}
                    </div>
                    <p>{turn.text}</p>
                    {turn.narration?.fidelity.status === "rejected" && (
                      <small className="narration-detail">
                        Candidate rejected by fact-fidelity verification · verified template shown
                      </small>
                    )}
                    <time>{new Date(turn.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  </div>
                ))}
                {snapshot.partialTranscript && <div className="turn turn--caller turn--partial"><span>Listening</span><p>{snapshot.partialTranscript}<i /></p></div>}
                <div ref={transcriptEndRef} />
              </div>
            </section>

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
              <div className="subheading"><span>Tool calls</span><small>{snapshot.toolCalls.length} recorded</small></div>
              <div className="tool-stack">
                {snapshot.toolCalls.length === 0 && <p className="empty-state">No tools called yet. The server will expose arguments, result, status, and duration.</p>}
                {snapshot.toolCalls.map((tool, index) => (
                  <details className="tool-row" key={tool.id} open={index === snapshot.toolCalls.length - 1}>
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

            {snapshot.handoffSummary && (
              <section className="handoff-card">
                <span>Simulated human handoff</span>
                <h3>{snapshot.handoffSummary.queueLabel}</h3>
                <div>{snapshot.handoffSummary.reasons.map((reason) => <b key={reason}>{labelForState(reason)}</b>)}</div>
                <p>{snapshot.handoffSummary.requestSummary}</p>
                <small>No external queue or human was contacted.</small>
              </section>
            )}

            {(snapshot.outcome || evalResult) && (
              <section className={`outcome-card ${snapshot.outcome === "changed" || evalResult?.passed ? "outcome-card--success" : ""}`}>
                <span>Final call outcome</span>
                <h3>{snapshot.outcome ? labelForState(snapshot.outcome) : "Evaluation complete"}</h3>
                {evalResult && <div className="assertions">{evalResult.assertions.map((assertion) => <p key={assertion} className={assertion.startsWith("PASS") ? "pass" : "fail"}>{assertion}</p>)}</div>}
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
          </aside>
        </section>
      </main>

      <footer>
        <span>Meridian & Pine · fictional portfolio case study</span>
        <span>Browser → STT → deterministic policy → verified language → mock tool → TTS</span>
      </footer>
    </div>
  );
}
