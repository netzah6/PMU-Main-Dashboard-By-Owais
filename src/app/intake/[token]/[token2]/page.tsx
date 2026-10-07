import IntakePage from "../page";

/* Pretty link shape: /intake/<client-slug>/<token> — the slug is only
   cosmetic (the client's name in the link); the token alone authorizes.
   Old /intake/<token> links keep working through the parent route. */
export default function PrettyIntakePage({ params }: { params: { token: string; token2: string } }) {
  return <IntakePage params={{ token: params.token2 }} />;
}
