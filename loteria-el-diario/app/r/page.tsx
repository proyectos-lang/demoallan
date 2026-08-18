import { redirect } from "next/navigation";

import { fechaHonduras } from "@/lib/format";

/** `/r` lleva siempre al día en curso en Honduras. */
export default function ResultadosHoy() {
  redirect(`/r/${fechaHonduras()}`);
}
