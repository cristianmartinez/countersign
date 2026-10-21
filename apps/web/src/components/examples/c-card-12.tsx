/** @jsxImportSource react */
// Adapted from the installed ReUI @reui/c-card-12 pattern.
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Field, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../ui/input-group";
import { EyeOffIcon, EyeIcon } from "lucide-react";

export function LoginCard({ csrf }: { csrf: string }) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <Card className="mx-auto w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="m-0 text-xl">Sign in to Countersign</h1>
        </CardTitle>
        <CardDescription>
          Review what your agent prepared. You decide what gets sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="/login" className="m-0 grid gap-6">
          <input type="hidden" name="csrf" value={csrf} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email-12">Email</FieldLabel>
              <Input
                name="email"
                autoComplete="username"
                id="email-12"
                type="email"
                placeholder="name@example.com"
                required
              />
            </Field>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="password-12">Password</FieldLabel>
              </div>
              <InputGroup>
                <InputGroupInput
                  name="password"
                  autoComplete="current-password"
                  id="password-12"
                  placeholder="Password"
                  type={isVisible ? "text" : "password"}
                  required
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    aria-label={isVisible ? "Hide password" : "Show password"}
                    onClick={() => setIsVisible(!isVisible)}
                  >
                    {isVisible ? (
                      <EyeOffIcon aria-hidden="true" />
                    ) : (
                      <EyeIcon aria-hidden="true" />
                    )}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </FieldGroup>
          <div className="flex flex-col gap-6">
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </div>
        </form>
      </CardContent>
      <CardFooter>
        <p className="m-0 text-muted-foreground w-full text-center text-xs">
          Access is provided through your reviewer account.
        </p>
      </CardFooter>
    </Card>
  );
}
