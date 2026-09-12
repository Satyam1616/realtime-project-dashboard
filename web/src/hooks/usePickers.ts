/**
 * Picker data.
 *
 * Both lists are role-gated server-side (`/users/assignable` and `/clients` are
 * refused to a developer), so these hooks take `enabled` and the callers pass
 * the cosmetic predicate from `lib/permissions.ts`. Requesting them anyway
 * would work — the API would simply answer 403 — but firing a request whose
 * only possible outcome is a denial is noise in the network tab and in the
 * server log.
 */
import type { AssignableUserDto, ClientDto, Paged } from '../types/api';
import { useApiQuery } from './useApiQuery';

export const useAssignableUsers = (
  enabled: boolean,
  projectId?: string,
): { users: AssignableUserDto[]; loading: boolean } => {
  const { data, loading } = useApiQuery<{ users: AssignableUserDto[] }>(
    projectId ? `/users/assignable?projectId=${projectId}` : '/users/assignable',
    enabled,
  );
  return { users: data?.users ?? [], loading };
};

export const useClients = (enabled: boolean): { clients: ClientDto[]; loading: boolean } => {
  const { data, loading } = useApiQuery<Paged<ClientDto>>('/clients?limit=100', enabled);
  return { clients: data?.items ?? [], loading };
};
