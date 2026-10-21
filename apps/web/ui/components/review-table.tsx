/** @jsxImportSource react */
import { Fragment } from "react";
import { Avatar, AvatarFallback } from "../../src/components/ui/avatar";
import { Card, CardFooter } from "../../src/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyDescription,
} from "../../src/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../../src/components/ui/input-group";
import { Label } from "../../src/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../src/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "../../src/components/ui/pagination";
import type { ReviewQueuePage, ReviewQueueOptions } from "@countersign/db";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Badge } from "../../src/components/reui/badge";
import { Button } from "../../src/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../src/components/ui/table";

export type ReviewTableProps = ReviewQueuePage;

const states = [
  "drafted",
  "in_review",
  "rejected",
  "approved",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "failed",
];

export function ReviewTable(props: ReviewTableProps) {
  const {
    items,
    total,
    page,
    pageCount,
    pageSize,
    q,
    status,
    sort,
    direction,
  } = props;

  const statusItems = [
    {
      value: "",
      label: "All statuses",
    },
    ...states.map((value) => ({
      value,
      label: value === "drafted" ? "draft" : value.replaceAll("_", " "),
    })),
  ];

  function href(change: Record<string, string | number> = {}) {
    const params = new URLSearchParams({
      q,
      status,
      sort,
      direction,
      pageSize: String(pageSize),
      page: String(page),
      ...Object.fromEntries(
        Object.entries(change).map(([key, value]) => [key, String(value)]),
      ),
    });

    for (const [key, value] of params) if (!value) params.delete(key);

    return `/review?${params}`;
  }

  function sortHeader(label: string, key: ReviewQueueOptions["sort"]) {
    const active = sort === key,
      Icon = active
        ? direction === "asc"
          ? ArrowUp
          : ArrowDown
        : ChevronsUpDown;

    return (
      <Button
        nativeButton={false}
        render={
          <a
            href={href({
              sort: key!,
              direction: active && direction === "asc" ? "desc" : "asc",
              page: 1,
            })}
          />
        }
        variant="ghost"
        size="xs"
        className="-ml-2"
      >
        {label}
        <Icon className="size-3" aria-hidden="true" />
      </Button>
    );
  }

  const visiblePages = Array.from(
    new Set([
      1,
      ...Array.from(
        { length: Math.min(5, pageCount) },
        (_, i) => Math.max(1, Math.min(page - 2, pageCount - 4)) + i,
      ),
      pageCount,
    ]),
  ).sort((a, b) => a - b);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <h1 className="m-0 text-lg">Emails</h1>
          <Badge variant="secondary">
            {total} {total === 1 ? "email" : "emails"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            nativeButton={false}
            render={<a href={href()} />}
            variant="outline"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Refresh
          </Button>
          <Button nativeButton={false} render={<a href="/connect" />}>
            Connect your agent
          </Button>
        </div>
      </div>
      <Card className="gap-0 overflow-visible py-0 shadow-xs">
        <form
          id="review-filters"
          action="/review"
          method="get"
          className="m-0 flex flex-wrap items-center gap-2 rounded-t-xl border-b bg-muted/20 p-3"
        >
          <input type="hidden" name="pageSize" value={pageSize} />
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="direction" value={direction} />

          <Label htmlFor="review-status">Status</Label>
          <Select name="status" defaultValue={status} items={statusItems}>
            <SelectTrigger id="review-status" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {statusItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <InputGroup className="w-60 min-w-48 max-w-full bg-background">
            <InputGroupInput
              aria-label="Search emails"
              name="q"
              type="search"
              maxLength={200}
              defaultValue={q}
              placeholder="Subject or recipient…"
            />
            <InputGroupAddon>
              <Search className="size-3.5" aria-hidden="true" />
            </InputGroupAddon>
          </InputGroup>
          <Button type="submit" variant="outline">
            Search
          </Button>
          {(q || status) && (
            <Button
              nativeButton={false}
              render={<a href={`/review?pageSize=${pageSize}`} />}
              variant="ghost"
              className="ml-auto"
            >
              <X className="size-3.5" aria-hidden="true" />
              Clear
            </Button>
          )}
        </form>
        <Table
          className="m-0 w-full table-fixed sm:table-auto"
          aria-label="Emails"
        >
          <TableHeader className="bg-muted/20">
            <TableRow className="hover:bg-transparent">
              <TableHead
                className="w-[45%] sm:w-[32%]"
                aria-sort={
                  sort === "created"
                    ? direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                {sortHeader("Email", "created")}
              </TableHead>
              <TableHead
                className="hidden sm:table-cell"
                aria-sort={
                  sort === "recipient"
                    ? direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                {sortHeader("Recipient", "recipient")}
              </TableHead>
              <TableHead
                className="hidden sm:table-cell"
                aria-sort={
                  sort === "revision"
                    ? direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                {sortHeader("Revision", "revision")}
              </TableHead>
              <TableHead
                aria-sort={
                  sort === "status"
                    ? direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                {sortHeader("Status", "status")}
              </TableHead>
              <TableHead className="w-20">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length ? (
              items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <a
                      className="font-medium whitespace-normal wrap-anywhere"
                      href={`/review/drafts/${row.id}`}
                    >
                      {row.subject}
                    </a>
                    <div className="mt-1 whitespace-normal wrap-anywhere text-xs text-muted-foreground sm:hidden">
                      {row.recipient}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      <time dateTime={new Date(row.created_at).toISOString()}>
                        {new Intl.DateTimeFormat("en", {
                          dateStyle: "medium",
                          timeZone: "UTC",
                        }).format(row.created_at)}
                      </time>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="flex items-center gap-2.5">
                      <Avatar aria-hidden="true" className="size-7">
                        <AvatarFallback className="text-[10px] font-medium">
                          {row.recipient.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="max-w-72 truncate" title={row.recipient}>
                        {row.recipient}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div>Revision {row.number}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Current version
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.status === "in_review"
                          ? "warning-light"
                          : row.status === "sent" || row.status === "delivered"
                            ? "success-light"
                            : row.status === "failed" ||
                                row.status === "bounced" ||
                                row.status === "rejected"
                              ? "destructive-light"
                              : "secondary"
                      }
                    >
                      {row.status === "drafted"
                        ? "draft"
                        : row.status.replaceAll("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      nativeButton={false}
                      render={<a href={`/review/drafts/${row.id}`} />}
                      variant="outline"
                      size="sm"
                    >
                      {row.status === "in_review" ? "Review" : "View"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-40 text-center text-muted-foreground"
                >
                  <Empty className="whitespace-normal">
                    <EmptyHeader>
                      <EmptyDescription>
                        {q || status
                          ? "No emails match these filters."
                          : "No emails yet. Connect your agent to get started."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <CardFooter className="flex flex-wrap items-center justify-between gap-4 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
          <form
            action="/review"
            method="get"
            className="m-0 flex items-center gap-2"
          >
            {Object.entries({ q, status, sort, direction }).map(
              ([key, value]) => (
                <input key={key} type="hidden" name={key} value={value} />
              ),
            )}
            <Label htmlFor="review-page-size" className="text-xs">
              Rows per page
            </Label>
            <Select
              name="pageSize"
              defaultValue={String(pageSize)}
              items={[8, 20, 50].map((size) => ({
                value: String(size),
                label: String(size),
              }))}
            >
              <SelectTrigger id="review-page-size" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {[8, 20, 50].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="ghost" size="xs">
              Apply
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <span>
              {total ? (page - 1) * pageSize + 1 : 0}–
              {Math.min(page * pageSize, total)} of {total}
            </span>
            <Pagination aria-label="Email pagination" className="mx-0 w-auto">
              <PaginationContent className="flex-wrap">
                <PaginationItem>
                  <PaginationPrevious
                    aria-label="Previous page"
                    href={page > 1 ? href({ page: page - 1 }) : undefined}
                    aria-disabled={page === 1}
                    tabIndex={page === 1 ? -1 : undefined}
                    className={
                      page === 1 ? "pointer-events-none opacity-30" : undefined
                    }
                  />
                </PaginationItem>
                {visiblePages.map((p, i) => (
                  <Fragment key={p}>
                    {i > 0 && p > visiblePages[i - 1]! + 1 && (
                      <PaginationItem>
                        <PaginationEllipsis />
                      </PaginationItem>
                    )}
                    <PaginationItem>
                      <PaginationLink
                        href={href({ page: p })}
                        aria-label={`Page ${p}`}
                        isActive={p === page}
                      >
                        {p}
                      </PaginationLink>
                    </PaginationItem>
                  </Fragment>
                ))}
                <PaginationItem>
                  <PaginationNext
                    aria-label="Next page"
                    href={
                      page < pageCount ? href({ page: page + 1 }) : undefined
                    }
                    aria-disabled={page === pageCount}
                    tabIndex={page === pageCount ? -1 : undefined}
                    className={
                      page === pageCount
                        ? "pointer-events-none opacity-30"
                        : undefined
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </CardFooter>
      </Card>
    </>
  );
}
