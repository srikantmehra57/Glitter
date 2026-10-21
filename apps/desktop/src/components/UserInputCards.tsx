import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { currentThread, useAppStore } from "../lib/store";
import { EXIT_MS, motionReduced } from "../lib/presence";
import { AGENT_LABELS, type UserInputRequest } from "../lib/types";
import { UserInputCard } from "./UserInputCard";

const keyOf = (request: UserInputRequest) => `${request.sessionId}:${request.userInputId}`;

/** Every open question of the current thread, as cards. */
export function UserInputCards() {
  // Questions and the flags that lock them, not the thread that changes every token.
  const { requests, agentId, disabled } = useAppStore(useShallow((state) => {
    const thread = currentThread(state);
    return { requests: thread?.userInputs, agentId: thread?.agentId ?? "muse", disabled: Boolean(thread?.userInputPending || thread?.cancelRequested || !thread?.opened) };
  }));
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  const live = useMemo(() => new Map((requests ?? []).map((request) => [keyOf(request), request])), [requests]);
  // Answered requests keep rendering for one exit, so the card animates out
  // instead of vanishing on the same frame — the shared `closing` convention.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, UserInputRequest>>(new Map());
  const previous = useRef(live);
  useEffect(() => {
    const gone = [...previous.current.values()].filter((request) => !live.has(keyOf(request)));
    previous.current = live;
    if (!gone.length || motionReduced()) return;
    setLeaving((map) => {
      const next = new Map(map);
      for (const request of gone) next.set(keyOf(request), request);
      return next;
    });
    const timer = window.setTimeout(() => {
      setLeaving((map) => {
        const next = new Map(map);
        for (const request of gone) next.delete(keyOf(request));
        return next;
      });
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [live]);
  const exiting = [...leaving.values()].filter((request) => !live.has(keyOf(request)));
  return <>
    {[...live.values()].map((request) => <UserInputCard
      key={keyOf(request)} request={request}
      agentName={agentName}
      disabled={disabled}
    />)}
    {exiting.map((request) => <UserInputCard
      key={keyOf(request)} request={request}
      agentName={agentName}
      disabled
      closing
    />)}
  </>;
}
