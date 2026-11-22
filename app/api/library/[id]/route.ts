import { libraryConfigured, readShared } from "@/lib/library/store";

/** The drawing of one pattern of the shared library (lib/library/store.ts), to be worn. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!libraryConfigured()) return Response.json({ error: "Ce patron n'existe pas." }, { status: 404 });
  try {
    const pattern = await readShared(id);
    return pattern ? Response.json(pattern) : Response.json({ error: "Ce patron n'existe pas." }, { status: 404 });
  } catch (e) {
    console.error("library read:", e);
    return Response.json({ error: "La bibliothèque commune n'a pas répondu." }, { status: 502 });
  }
}
