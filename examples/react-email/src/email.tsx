import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "react-email";
import { render, toPlainText } from "react-email";

export interface ThankYouProps {
  name: string;
  message: string;
}

export function ThankYouEmail({ name, message }: ThankYouProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your email approval workflow is ready to review.</Preview>
      <Body
        style={{
          backgroundColor: "#f5f5f4",
          fontFamily: "Arial, sans-serif",
          color: "#1c1917",
        }}
      >
        <Container
          style={{
            maxWidth: "560px",
            margin: "32px auto",
            padding: "32px",
            backgroundColor: "#ffffff",
          }}
        >
          <Text style={{ fontSize: "12px", letterSpacing: "2px" }}>
            COUNTERSIGN
          </Text>
          <Heading as="h1">Thank you, {name}.</Heading>
          <Section>
            <Text>{message}</Text>
            <Text>
              This email was prepared as a draft. A human must approve the
              recipients and both body versions before it can be sent.
            </Text>
          </Section>
          <Hr />
          <Text style={{ fontSize: "12px", color: "#57534e" }}>
            Prepared with React Email. Sent through Resend only after approval.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderDraft(
  props: ThankYouProps = {
    name: "reviewer",
    message:
      "Thank you for trying Countersign. Please review this example before approving it.",
  },
) {
  const html = await render(<ThankYouEmail {...props} />),
    text = toPlainText(html);

  // This is an ordinary REST body. There is no Resend key or network call here.
  return {
    to: ["delivered@resend.dev"] as [string],
    subject: "A human-approved thank you",
    html,
    text,
  };
}
