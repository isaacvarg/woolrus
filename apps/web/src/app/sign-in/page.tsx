import { SignInForm } from "./sign-in-form";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { email } = await searchParams;
  return <SignInForm initialEmail={typeof email === "string" ? email : ""} />;
}
