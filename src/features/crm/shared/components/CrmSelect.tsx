import { Input as UiInput } from "../../../../components/ui/Input";
import { ListBox, ListBoxItem, Select } from "@heroui/react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { normalizeText } from "../../../../lib/format";

export type CrmSelectOption = {
  description?: string;
  disabled?: boolean;
  filterValues?: readonly string[];
  label: string;
  value: string;
};

export type CrmSelectFilterOption = {
  label: string;
  value: string;
};

type Props = {
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
  defaultValue?: string;
  disabled?: boolean;
  emptyMessage?: string;
  filterOptions?: CrmSelectFilterOption[];
  filterPlaceholder?: string;
  leadingIcon?: ReactNode;
  menuLabel?: string;
  name?: string;
  onChange?: (value: string) => void;
  options: CrmSelectOption[];
  placeholder?: string;
  required?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  value?: string;
};

export function CrmSelect({
  ariaLabel,
  className = "",
  compact = false,
  defaultValue = "",
  disabled = false,
  emptyMessage = "No hay opciones que coincidan.",
  filterOptions = [],
  filterPlaceholder = "Categorías",
  leadingIcon,
  menuLabel,
  name,
  onChange,
  options,
  placeholder = "Selecciona una opci\u00f3n",
  required = false,
  searchable = false,
  searchPlaceholder = "Buscar...",
  value,
}: Props) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const [query, setQuery] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const selectedValue = value ?? uncontrolledValue;
  const selectedOption = options.find(
    (option) => option.value === selectedValue,
  );
  const isDisabled = disabled || options.every((option) => option.disabled);
  const selectedFilter = filterOptions.find(
    (option) => option.value === filterValue,
  );
  const visibleOptions = useMemo(() => {
    const normalizedQuery = normalizeText(deferredQuery.trim());
    return options.filter((option) => {
      if (
        normalizedQuery &&
        !normalizeText(`${option.label} ${option.description ?? ""}`).includes(
          normalizedQuery,
        )
      )
        return false;
      return !filterValue || option.filterValues?.includes(filterValue);
    });
  }, [deferredQuery, filterValue, options]);

  return (
    <div className={`relative min-w-0 w-full ${className}`}>
      {name ? (
        <UiInput name={name} type="hidden" value={selectedValue} />
      ) : null}
      <Select
        aria-label={ariaLabel ?? menuLabel ?? placeholder}
        fullWidth
        isDisabled={isDisabled}
        isRequired={required}
        onSelectionChange={(key) => {
          if (key === null) return;
          const nextValue = String(key);
          if (value === undefined) setUncontrolledValue(nextValue);
          onChange?.(nextValue);
          setQuery("");
          setFilterOpen(false);
        }}
        selectedKey={selectedValue || null}
        variant="secondary"
      >
        <Select.Trigger
          aria-haspopup="listbox"
          className={`!flex !min-w-0 !items-center !gap-2.5 !border !border-[var(--crm-input-border)] !bg-[var(--crm-input-bg)] !leading-none !font-medium !text-[var(--crm-text)] focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)] ${compact ? "!h-9 !rounded-[9px] !px-2.5 !text-[12px]" : "!h-11 !rounded-[10px] !px-3 !text-[13px]"}`}
        >
          {leadingIcon ? (
            <span className="!flex !size-[18px] !shrink-0 !items-center [&_svg]:!size-[18px]">
              {leadingIcon}
            </span>
          ) : null}
          <span className="!flex !w-0 !min-w-0 !flex-1 !items-center !gap-3">
            <Select.Value
              className={`!flex !min-w-0 !flex-1 !items-center !truncate !leading-none ${selectedOption ? "" : "!text-[var(--crm-text-muted)]"}`}
            >
              {selectedOption?.label ?? placeholder}
            </Select.Value>
            <span
              aria-hidden="true"
              className="!flex !size-5 !shrink-0 !items-center !justify-center !text-[var(--crm-text-muted)]"
            >
              <ChevronDown className="!size-4" />
            </span>
          </span>
        </Select.Trigger>
        <Select.Popover
          className="!z-[120] !flex !max-h-72 !min-w-[var(--trigger-width)] !flex-col !overflow-hidden !rounded-[12px] !border  !bg-[var(--crm-popover-bg)] !p-1 !text-[var(--crm-popover-text)]  !shadow-[var(--crm-shadow-floating)] !backdrop-blur-none [&_[role=listbox]]:!bg-[var(--crm-popover-bg)] [&_[role=listbox]]:!text-[var(--crm-popover-text)]"
          placement="bottom"
        >
          {searchable || filterOptions.length ? (
            <div
              className={`!grid !gap-2 !border-b  !p-2 ${searchable && filterOptions.length ? "!grid-cols-[minmax(0,1fr)_132px]" : "!grid-cols-1"}`}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {searchable ? (
                <label className="!flex !h-9 !min-w-0 !items-center !gap-2 !rounded-[9px] !border !bg-field !px-2.5 focus-within:!border-[var(--crm-blue)] focus-within:!shadow-[0_0_0_3px_var(--crm-blue-soft)]">
                  <Search
                    aria-hidden="true"
                    className="!size-3.5 !shrink-0 !text-[var(--crm-text-muted)]"
                  />
                  <UiInput
                    aria-label={searchPlaceholder}
                    autoComplete="off"
                    className="!min-h-0 !border-0 !bg-transparent !p-0 !text-[12px] focus:!shadow-none"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={searchPlaceholder}
                    type="search"
                    value={query}
                  />
                </label>
              ) : null}
              {filterOptions.length ? (
                <div className="!relative">
                  <button
                    aria-expanded={filterOpen}
                    aria-haspopup="listbox"
                    className="!flex !h-9 !w-full !items-center !justify-between !gap-2 !rounded-[9px] !border !bg-[var(--crm-input-bg)] !px-2.5 !text-left !text-[12px] !font-medium !text-[var(--crm-text)]"
                    onClick={() => setFilterOpen((open) => !open)}
                    type="button"
                  >
                    <span className="!truncate">
                      {selectedFilter?.label ?? filterPlaceholder}
                    </span>
                    <ChevronDown className="!size-3.5 !shrink-0 !text-[var(--crm-text-muted)]" />
                  </button>
                  {filterOpen ? (
                    <div
                      aria-label={filterPlaceholder}
                      className="!absolute !right-0 !top-[calc(100%+4px)] !z-[125] !max-h-56 !w-52 !overflow-y-auto !rounded-[10px] !border !border-[var(--crm-popover-border)] !bg-[var(--crm-popover-bg)] !p-1 !shadow-[var(--crm-shadow-floating)]"
                      role="listbox"
                    >
                      {filterOptions.map((filter) => (
                        <button
                          aria-selected={filter.value === filterValue}
                          className={`!flex !min-h-9 !w-full !items-center !justify-between !rounded-lg !px-2.5 !text-left !text-[12px] hover:!bg-[var(--crm-popover-hover)] ${filter.value === filterValue ? "!bg-[var(--crm-popover-selected)]" : ""}`}
                          key={filter.value || "__all"}
                          onClick={() => {
                            setFilterValue(filter.value);
                            setFilterOpen(false);
                          }}
                          role="option"
                          type="button"
                        >
                          <span className="!truncate">{filter.label}</span>
                          {filter.value === filterValue ? (
                            <Check className="!size-3.5 !shrink-0 !text-[var(--crm-popover-accent)]" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {visibleOptions.length ? (
            <ListBox
              aria-label={menuLabel ?? ariaLabel ?? placeholder}
              className="!overflow-y-auto !bg-[var(--crm-popover-bg)]"
              items={visibleOptions}
            >
              {(option) => (
                <ListBoxItem
                  className="!flex !min-h-10 !items-center !gap-3 !rounded-lg !bg-transparent !px-3 !py-2 !text-[13px] !leading-tight !text-[var(--crm-popover-text)] hover:!bg-[var(--crm-popover-hover)] data-[focused]:!bg-[var(--crm-popover-hover)] data-[hovered]:!bg-[var(--crm-popover-hover)] data-[selected]:!bg-[var(--crm-popover-selected)]"
                  id={option.value}
                  isDisabled={option.disabled}
                  textValue={option.label}
                >
                  <span className="!min-w-0 !flex-1 !pr-2.5">
                    <span className="!block !truncate">{option.label}</span>
                    {option.description ? (
                      <small className="!mt-0.5 !block !truncate !text-[11px] !font-medium !text-[var(--crm-popover-muted)]">
                        {option.description}
                      </small>
                    ) : null}
                  </span>
                  <span
                    aria-hidden="true"
                    className="!ml-auto !flex !size-5 !shrink-0 !items-center !justify-center"
                  >
                    {option.value === selectedValue ? (
                      <Check className="!size-4 !shrink-0 !stroke-[2.5] !text-[var(--crm-popover-accent)]" />
                    ) : null}
                  </span>
                </ListBoxItem>
              )}
            </ListBox>
          ) : (
            <p
              className="!px-4 !py-6 !text-center !text-[12px] !font-medium !text-[var(--crm-popover-muted)]"
              role="status"
            >
              {emptyMessage}
            </p>
          )}
        </Select.Popover>
      </Select>
    </div>
  );
}
