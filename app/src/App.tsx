import { MapView } from "./ui/MapView";

export function App() {
  return (
    <div className="flex h-full w-full">
      <aside className="w-80 shrink-0 border-r border-slate-200 bg-slate-50 p-4">
        <h1 className="text-lg font-semibold text-slate-900">Trip Planner</h1>
        <p className="mt-2 text-sm text-slate-600">
          GA route planning with fuel stops, terrain warnings, and approach
          filters. Map shown is a placeholder until the NASR airport dataset
          ships in Phase 2.
        </p>
      </aside>
      <main className="relative flex-1">
        <MapView />
      </main>
    </div>
  );
}
