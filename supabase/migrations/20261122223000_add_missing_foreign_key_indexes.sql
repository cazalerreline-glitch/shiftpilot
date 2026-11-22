CREATE INDEX IF NOT EXISTS absences_employee_org_idx ON public."Absences" (employee_id, organization_id);
CREATE INDEX IF NOT EXISTS shifts_employee_org_idx ON public."Shifts" (employee_id, organization_id);
CREATE INDEX IF NOT EXISTS invitations_employee_id_idx ON public."ShiftPilotInvitations" (employee_id);
CREATE INDEX IF NOT EXISTS invitations_invited_by_idx ON public."ShiftPilotInvitations" (invited_by);
CREATE INDEX IF NOT EXISTS invitations_organization_id_idx ON public."ShiftPilotInvitations" (organization_id);