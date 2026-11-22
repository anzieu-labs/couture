import { libraryConfigured, listShared } from "@/lib/library/store";

/** The shared library of patterns (lib/library/store.ts), as the garment picker lists it: the latest first. Empty where the library is not set up. */
export async function GET() {
  if (!libraryConfigured()) return Response.json({ patterns: [], shared: false });
  try {
    return Response.json({ patterns: await listShared(), shared: true });
  } catch (e) {
    console.error("library list:", e);
    return Response.json({ error: "La bibliothèque commune n'a pas répondu." }, { status: 502 });
  }
}
