import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function RootRedirect() {
  const cookieStore = cookies();
  const hasToken = cookieStore.has("sp_token");
  redirect(hasToken ? "/dashboard" : "/login");
}
