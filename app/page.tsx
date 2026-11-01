import { redirect } from "next/navigation";

/** Home is the dashboard (it links to Compose and shows an empty state for new users). */
export default function Home() {
  redirect("/dashboard");
}
