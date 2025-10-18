import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function Home() {
  const hasToken = cookies().has("sp_token");
  redirect(hasToken ? "/dashboard" : "/login");
}
