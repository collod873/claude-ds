export interface JobFixture {
  id: string;
  customer: string;
  status: "open" | "scheduled" | "done";
  total: number;
}

export const JOB_STATUS_LABEL: Record<JobFixture["status"], string> = {
  open: "Open",
  scheduled: "Scheduled",
  done: "Done",
};

export const acmeJobs: JobFixture[] = [
  { id: "j1", customer: "Acme Co.", status: "open", total: 100 },
  { id: "j2", customer: "Globex", status: "scheduled", total: 250 },
];

export const longCustomerNameJob: JobFixture = {
  id: "j-long",
  customer: "A very long customer name that wraps the column",
  status: "done",
  total: 999,
};
