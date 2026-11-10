/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic tenant URLs are assembled from server-resolved route metadata */
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";

import { usePresentedDestination } from "../navigation/index.js";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../components/ui/sidebar.js";

export interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** The destination owns pages beneath it, so it stays lit while any of them is open. */
  subtree?: boolean;
}

export interface NavigationSection {
  label?: string;
  items: readonly NavigationItem[];
}

/**
 * One navigation landmark per scope, with quiet labels grouping related destinations. Going
 * up stays separate from going across, so the way back precedes every section.
 */
export function NavigationGroup({
  label,
  back,
  sections,
}: {
  /** Names the level, e.g. "Organization". Becomes the landmark's accessible name. */
  label: string;
  back?: NavigationItem;
  sections: readonly NavigationSection[];
}) {
  return (
    <nav aria-label={label}>
      {back === undefined ? null : (
        <>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem item={back} />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
        </>
      )}
      {sections.map((section) => (
        <SidebarGroup
          key={section.label ?? section.items[0]?.to}
          role={section.label === undefined ? undefined : "group"}
          aria-label={section.label}
        >
          {section.label === undefined ? null : (
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => (
                <NavItem key={item.to} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  );
}

/**
 * Navigation stays inside the running app. A plain anchor reloads the document, which
 * throws away the resolved account and repaints the pre-auth shell on every hop.
 */
function NavItem({ item }: { item: NavigationItem }) {
  const { to, label, icon: Icon, subtree = false } = item;
  const active = usePresentedDestination(to, subtree);
  const { isMobile, setOpenMobile } = useSidebar();
  // On compact the sidebar is an overlay covering the destination. A document load used
  // to dismiss it; client-side navigation has to dismiss it deliberately.
  const navigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link to={to as never} aria-current={active ? "page" : undefined} onClick={navigate}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
