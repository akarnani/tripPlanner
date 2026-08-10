import { useEffect, useRef, useState } from "react";
import type { Airport, NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import type { FlightRule } from "@/engine/hemispheric";
import type { PlannedRoute } from "@/engine/plan";
import type {
  PlanWorkerRequest,
  PlanWorkerResponse,
} from "@/engine/plan.worker";

export interface PlanRequest {
  candidates: Airport[];
  originId: string;
  destinationId: string;
  aircraft: Aircraft;
  targetAltFt: number;
  maxAltFt?: number | null;
  flightRule: FlightRule;
  reserveHr: number;
  maxLegHr?: number;
  startingFuelGal: number;
  excludedAirportIds: string[];
  waypoints: string[];
  navPoints: NavPoint[];
}

export interface CeilingDiagnosisResult {
  lowestWorkableFt: number | null;
  blockerFrom: string | null;
  blockerTo: string | null;
  blockerRequiredAltFt: number | null;
}

interface PlanCallbacks {
  onResult(routes: PlannedRoute[], meta: { demUsed: boolean }): void;
  onError(message: string): void;
  /** Only fired for a `requestDiagnosis` call. */
  onDiagnosis?(d: CeilingDiagnosisResult): void;
}

function spawnWorker(): Worker {
  return new Worker(new URL("../engine/plan.worker.ts", import.meta.url), {
    type: "module",
  });
}

/** Runs the route planner in a Web Worker so the k-shortest-paths
 *  search never blocks the main thread (T9). One in-flight request at
 *  a time: a new requestPlan supersedes the previous one, and cancel()
 *  is a hard stop — the search loop is synchronous inside the worker,
 *  so the only way to actually free the CPU is terminate + respawn. */
export function usePlanner(): {
  requestPlan(req: PlanRequest, cb: PlanCallbacks): void;
  requestDiagnosis(req: PlanRequest, cb: PlanCallbacks): void;
  cancel(): void;
  isPlanning: boolean;
  progress: { expanded: number; found: number } | null;
} {
  const workerRef = useRef<Worker | null>(null);
  // Monotonic request id; responses carrying any other id are stale
  // (superseded or cancelled) and dropped.
  const idRef = useRef(0);
  const callbacksRef = useRef<PlanCallbacks | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [progress, setProgress] = useState<{
    expanded: number;
    found: number;
  } | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  function handleMessage(event: MessageEvent<PlanWorkerResponse>) {
    const msg = event.data;
    if (msg.id !== idRef.current) return;
    if (msg.type === "progress") {
      setProgress({ expanded: msg.expanded, found: msg.found });
      return;
    }
    const cb = callbacksRef.current;
    callbacksRef.current = null;
    setIsPlanning(false);
    setProgress(null);
    if (msg.type === "result") {
      cb?.onResult(msg.routes, { demUsed: msg.demUsed });
    } else if (msg.type === "diagnosis") {
      cb?.onDiagnosis?.({
        lowestWorkableFt: msg.lowestWorkableFt,
        blockerFrom: msg.blockerFrom,
        blockerTo: msg.blockerTo,
        blockerRequiredAltFt: msg.blockerRequiredAltFt,
      });
    } else {
      cb?.onError(msg.message);
    }
  }

  function ensureWorker(): Worker {
    if (!workerRef.current) {
      const w = spawnWorker();
      w.onmessage = handleMessage;
      w.onerror = (e) => {
        // A worker-level error (script load failure etc.) fails the
        // in-flight request; the worker is respawned on the next one.
        const cb = callbacksRef.current;
        callbacksRef.current = null;
        setIsPlanning(false);
        setProgress(null);
        workerRef.current?.terminate();
        workerRef.current = null;
        cb?.onError(e.message || "planner worker failed");
      };
      workerRef.current = w;
    }
    return workerRef.current;
  }

  function requestPlan(req: PlanRequest, cb: PlanCallbacks) {
    // Supersede any in-flight request. Terminating (rather than just
    // bumping the id) frees the worker CPU immediately, so the new
    // request isn't queued behind a doomed search.
    if (callbacksRef.current) {
      workerRef.current?.terminate();
      workerRef.current = null;
      callbacksRef.current = null;
    }
    const id = ++idRef.current;
    callbacksRef.current = cb;
    setIsPlanning(true);
    setProgress(null);
    const message: PlanWorkerRequest = { type: "plan", id, params: req };
    ensureWorker().postMessage(message);
  }

  /** Asks the worker for the lowest ceiling that admits a route. Same
   *  supersede semantics as requestPlan — it re-plans several times, so
   *  it must not run alongside a live search. */
  function requestDiagnosis(req: PlanRequest, cb: PlanCallbacks) {
    if (callbacksRef.current) {
      workerRef.current?.terminate();
      workerRef.current = null;
      callbacksRef.current = null;
    }
    const id = ++idRef.current;
    callbacksRef.current = cb;
    setIsPlanning(true);
    setProgress(null);
    const message: PlanWorkerRequest = { type: "diagnose", id, params: req };
    ensureWorker().postMessage(message);
  }

  function cancel() {
    idRef.current++;
    callbacksRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    setIsPlanning(false);
    setProgress(null);
  }

  return { requestPlan, requestDiagnosis, cancel, isPlanning, progress };
}
