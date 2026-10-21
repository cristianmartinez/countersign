/** @jsxImportSource react */
import { Button } from "../../src/components/ui/button";
import { Label } from "../../src/components/ui/label";
import { Textarea } from "../../src/components/ui/textarea";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../../src/components/ui/dialog";

export type RejectRevisionProps = {
  action: string;
  csrf: string;
  revision: string;
  hash: string;
  number: number;
};

export function RejectRevision({
  action,
  csrf,
  revision,
  hash,
  number,
}: RejectRevisionProps) {
  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="destructive" />}>
        Reject revision {number}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reject revision {number}?</DialogTitle>
          <DialogDescription>
            This revision will be rejected and won’t be sent. Tell your agent
            what needs to change before submitting a new revision.
          </DialogDescription>
        </DialogHeader>
        <form
          id="reject-revision-form"
          method="post"
          action={action}
          className="m-0 grid gap-2"
        >
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="revision_id" value={revision} />
          <input type="hidden" name="content_hash" value={hash} />
          <Label htmlFor="rejection-reason">Reason for rejection</Label>
          <Textarea
            id="rejection-reason"
            name="reason"
            required
            maxLength={2000}
            placeholder="Explain what needs to change…"
          />
          <p className="m-0 text-xs text-muted-foreground">
            Required. Up to 2,000 characters. Your agent can read this reason.
          </p>
        </form>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            type="submit"
            form="reject-revision-form"
            variant="destructive"
          >
            Confirm rejection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
