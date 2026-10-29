import { createContext, forwardRef, useContext, useMemo, useState, useSyncExternalStore } from "react";
import {
  Archive as LArchive, ArrowDown as LArrowDown, ArrowLeft as LArrowLeft, ArrowRight as LArrowRight,
  ArrowUp as LArrowUp, ArrowUpRight as LArrowUpRight, ArrowDownNarrowWide as LSort,
  BookMarked as LBookMarked, BookOpen as LBookOpen, Bookmark as LBookmark, CaseSensitive as LText,
  Check as LCheck, ChevronLeft as LCaretLeft, ChevronRight as LCaretRight, CircleAlert as LWarning,
  CircleCheck as LCheckCircle, CircleHelp as LQuestion, Copy as LCopy, Crosshair as LCrosshair,
  Ellipsis as LDots, ExternalLink as LExternalLink, Eye as LEye, FileText as LFileText, FileUp as LFileUp,
  Folder as LFolder, FolderOpen as LFolderOpen, Hash as LHash, Highlighter as LHighlighter,
  Inbox as LTray, Info as LInfo, Keyboard as LKeyboard, Languages as LTranslate, LibraryBig as LBooks,
  Link as LLink, ListChecks as LListChecks, Maximize2 as LExpand, Menu as LList,
  MessageSquareText as LChat, MessageSquareQuote as LInsight, Minimize as LCornersIn,
  Minimize2 as LContract, Minus as LMinus, Newspaper as LArticle, Notebook as LNotebook,
  Palette as LPalette, PencilLine as LPencil, Plus as LPlus, RefreshCw as LRefresh,
  RotateCcw as LReset, RotateCw as LReload, Search as LSearch, SlidersHorizontal as LSettings,
  SquarePen as LNote, Tag as LTag, Trash2 as LTrash, Undo2 as LReturn, Unlink as LUnlink,
  X as LX, ZoomIn as LZoomIn, ZoomOut as LZoomOut, Clock as LClock, CalendarDays as LCalendar,
} from "lucide-react";
import {
  Archive as IArchive, ArrowDown as IArrowDown, ArrowLeft as IArrowLeft, ArrowRight as IArrowRight,
  ArrowUp as IArrowUp, ArrowUpRight as IArrowUpRight, BookStack as IBooks, Bookmark as IBookmark,
  BookmarkBook as IBookMarked, ChatLines as IChat, Check as ICheck, CheckCircle as ICheckCircle,
  Collapse as IContract, Copy as ICopy, Drawer as ITray, EditPencil as IPencil, Expand as IExpand,
  Eye as IEye, Folder as IFolder, Hashtag as IHash, HelpCircle as IQuestion, InfoCircle as IInfo,
  Journal as IArticle, JournalPage as INotebook, Label as ITag, Language as ITranslate,
  Link as ILink, LinkSlash as IUnlink, List as IList, ListSelect as IListChecks,
  MessageText as IInsight, Minus as IMinus, MoreHoriz as IDots, NavArrowLeft as ICaretLeft,
  NavArrowRight as ICaretRight, OpenBook as IBookOpen, OpenNewWindow as IExternalLink,
  Page as IFileText, PageEdit as INote, PageUp as IFileUp, Palette as IPalette, Plus as IPlus,
  Position as ICrosshair, Redo as IReload, Reduce as ICornersIn, RefreshDouble as IRefresh,
  Search as ISearch, Settings as ISettings, SidebarCollapse as ISidebarPinned,
  SidebarExpand as ISidebar, SortUp as ISort, TextSize as IText, Trash as ITrash,
  Undo as IReset, UndoAction as IReturn, WarningCircle as IWarning, Xmark as IX,
  ZoomIn as IZoomIn, ZoomOut as IZoomOut, Clock as IClock, Calendar as ICalendar,
} from "iconoir-react";
import {
  Archive as PArchive, ArrowClockwise as PReload, ArrowCounterClockwise as PReset,
  ArrowDown as PArrowDown, ArrowLeft as PArrowLeft, ArrowRight as PArrowRight,
  ArrowSquareOut as PExternalLink, ArrowUUpLeft as PReturn, ArrowUp as PArrowUp,
  ArrowUpRight as PArrowUpRight, ArrowsClockwise as PRefresh, ArrowsInSimple as PContract,
  ArrowsOutSimple as PExpand, Article as PArticle, BookBookmark as PBookMarked,
  BookOpen as PBookOpen, BookmarkSimple as PBookmark, Books as PBooks, CaretLeft as PCaretLeft,
  CaretRight as PCaretRight, ChatText as PChat, ChatCenteredText as PInsight,
  Check as PCheck, CheckCircle as PCheckCircle, Copy as PCopy, CornersIn as PCornersIn,
  Crosshair as PCrosshair, DotsThree as PDots, Eye as PEye, FileArrowUp as PFileUp,
  FileText as PFileText, Folder as PFolder, FolderOpen as PFolderOpen, Hash as PHash,
  Highlighter as PHighlighter, Info as PInfo, Keyboard as PKeyboard, LinkBreak as PUnlink,
  LinkSimple as PLink, List as PList, ListChecks as PListChecks, MagnifyingGlass as PSearch,
  MagnifyingGlassMinus as PZoomOut, MagnifyingGlassPlus as PZoomIn, Minus as PMinus,
  NotePencil as PNote, Notebook as PNotebook, Palette as PPalette, PencilSimpleLine as PPencil,
  Plus as PPlus, Question as PQuestion, SidebarSimple as PSidebar, SlidersHorizontal as PSettings,
  SortAscending as PSort, Tag as PTag, TextAa as PText, Translate as PTranslate, Trash as PTrash,
  Tray as PTray, WarningCircle as PWarning, X as PX, Clock as PClock, CalendarBlank as PCalendar,
} from "@phosphor-icons/react";
import {
  DEFAULT_ICON_STYLE, ICON_STYLES, getIconStyleSnapshot, getServerIconStyleSnapshot,
  normalizeIconStyle, subscribeIconStyle, updateIconStyle,
} from "./icon-style.js";

export { ICON_STYLES };
const IconStyleContext = createContext({ style: DEFAULT_ICON_STYLE, setStyle: () => {}, sessionOnly: true });
export const useIconStyle = () => useContext(IconStyleContext);

export function IconStyleProvider({ children, persist = true }) {
  const stored = useSyncExternalStore(subscribeIconStyle, getIconStyleSnapshot, getServerIconStyleSnapshot);
  const [temporaryStyle, setTemporaryStyle] = useState(() => stored.style);
  const value = useMemo(() => ({
    style: persist ? stored.style : temporaryStyle,
    setStyle: persist ? updateIconStyle : (style) => setTemporaryStyle(normalizeIconStyle(style)),
    sessionOnly: !persist || stored.sessionOnly,
  }), [persist, stored, temporaryStyle]);
  return <IconStyleContext.Provider value={value}>{children}</IconStyleContext.Provider>;
}

export function IconStyleScope({ style, children }) {
  const value = useMemo(() => ({ style: normalizeIconStyle(style), setStyle: () => {}, sessionOnly: true }), [style]);
  return <IconStyleContext.Provider value={value}>{children}</IconStyleContext.Provider>;
}

// Two small companion glyphs fill gaps in Iconoir without changing their meaning.
const IKeyboard = forwardRef((props, ref) => <svg ref={ref} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="2" y="5" width="20" height="14" rx="1" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10" /></svg>);
const IHighlighter = forwardRef((props, ref) => <svg ref={ref} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="m9 15-4-4L15 1l6 6-10 10-2-2Z M5 11l-2 5 3 3 5-2M3 21h7" /></svg>);
const LSidebar = forwardRef(({ pinned, children, size: _size, ...props }, ref) => <svg ref={ref} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>{children}{pinned && <path d="M4 3h5v18H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="currentColor" stroke="none" />}<rect x="2" y="3" width="20" height="18" rx="2" /><path d="M9 3v18" /></svg>);

function createIcon(name, Lucide, Iconoir, Phosphor, { mechanical = false, sidebar = false } = {}) {
  const Icon = forwardRef(function ReaderIcon({ size = 20, weight, color = "currentColor", title, alt, mirrored, children, ...props }, ref) {
    const { style } = useIconStyle();
    const label = props["aria-label"] || title || alt;
    const labelled = Boolean(label || props["aria-labelledby"]);
    const common = {
      width: size, height: size, color, ref, focusable: false,
      "aria-hidden": labelled ? undefined : true, role: labelled ? "img" : undefined,
      "aria-label": label || undefined, title: title || alt || undefined,
      "data-icon-style": style, "data-icon-name": name,
      ...(mirrored ? { transform: "scale(-1, 1)" } : {}), ...props,
    };
    if (style === "ink") {
      const inkWeight = sidebar ? (weight === "fill" ? "fill" : "regular")
        : weight || (mechanical ? "regular" : "fill");
      return <Phosphor {...common} size={size} weight={inkWeight} alt={title || alt}>{children}</Phosphor>;
    }
    const bold = weight === "bold";
    if (style === "iconoir") {
      const Component = sidebar && weight === "fill" ? ISidebarPinned : Iconoir;
      return <Component {...common} strokeWidth={bold ? 1.9 : 1.5}>{children}</Component>;
    }
    return <Lucide {...common} size={size} strokeWidth={bold ? 2 : 1.7} {...(sidebar ? { pinned: weight === "fill" } : {})}>{title || alt ? <title>{title || alt}</title> : null}{children}</Lucide>;
  });
  Icon.displayName = name;
  return Icon;
}

const line = { mechanical: true };
export const Archive = createIcon("Archive", LArchive, IArchive, PArchive);
export const ArrowClockwise = createIcon("ArrowClockwise", LReload, IReload, PReload, line);
export const ArrowCounterClockwise = createIcon("ArrowCounterClockwise", LReset, IReset, PReset, line);
export const ArrowDown = createIcon("ArrowDown", LArrowDown, IArrowDown, PArrowDown, line);
export const ArrowLeft = createIcon("ArrowLeft", LArrowLeft, IArrowLeft, PArrowLeft, line);
export const ArrowRight = createIcon("ArrowRight", LArrowRight, IArrowRight, PArrowRight, line);
export const ArrowSquareOut = createIcon("ArrowSquareOut", LExternalLink, IExternalLink, PExternalLink, line);
export const ArrowUUpLeft = createIcon("ArrowUUpLeft", LReturn, IReturn, PReturn, line);
export const ArrowUp = createIcon("ArrowUp", LArrowUp, IArrowUp, PArrowUp, line);
export const ArrowUpRight = createIcon("ArrowUpRight", LArrowUpRight, IArrowUpRight, PArrowUpRight, line);
export const ArrowsClockwise = createIcon("ArrowsClockwise", LRefresh, IRefresh, PRefresh, line);
export const ArrowsInSimple = createIcon("ArrowsInSimple", LContract, IContract, PContract, line);
export const ArrowsOutSimple = createIcon("ArrowsOutSimple", LExpand, IExpand, PExpand, line);
export const Article = createIcon("Article", LArticle, IArticle, PArticle);
export const BookmarkSimple = createIcon("BookmarkSimple", LBookmark, IBookmark, PBookmark);
export const BookOpen = createIcon("BookOpen", LBookOpen, IBookOpen, PBookOpen);
export const Books = createIcon("Books", LBooks, IBooks, PBooks);
export const CalendarBlank = createIcon("CalendarBlank", LCalendar, ICalendar, PCalendar);
export const CaretLeft = createIcon("CaretLeft", LCaretLeft, ICaretLeft, PCaretLeft, line);
export const CaretRight = createIcon("CaretRight", LCaretRight, ICaretRight, PCaretRight, line);
export const ChatText = createIcon("ChatText", LChat, IChat, PChat);
export const Check = createIcon("Check", LCheck, ICheck, PCheck, line);
export const CheckCircle = createIcon("CheckCircle", LCheckCircle, ICheckCircle, PCheckCircle);
export const Clock = createIcon("Clock", LClock, IClock, PClock);
export const Copy = createIcon("Copy", LCopy, ICopy, PCopy);
export const CornersIn = createIcon("CornersIn", LCornersIn, ICornersIn, PCornersIn, line);
export const Crosshair = createIcon("Crosshair", LCrosshair, ICrosshair, PCrosshair, line);
export const DotsThree = createIcon("DotsThree", LDots, IDots, PDots, line);
export const Eye = createIcon("Eye", LEye, IEye, PEye);
export const FileArrowUp = createIcon("FileArrowUp", LFileUp, IFileUp, PFileUp);
export const FileText = createIcon("FileText", LFileText, IFileText, PFileText);
export const Folder = createIcon("Folder", LFolder, IFolder, PFolder);
export const FolderOpen = createIcon("FolderOpen", LFolderOpen, IFolder, PFolderOpen);
export const Hash = createIcon("Hash", LHash, IHash, PHash, line);
export const Highlighter = createIcon("Highlighter", LHighlighter, IHighlighter, PHighlighter);
export const Info = createIcon("Info", LInfo, IInfo, PInfo);
export const Keyboard = createIcon("Keyboard", LKeyboard, IKeyboard, PKeyboard);
export const LinkBreak = createIcon("LinkBreak", LUnlink, IUnlink, PUnlink, line);
export const LinkSimple = createIcon("LinkSimple", LLink, ILink, PLink, line);
export const List = createIcon("List", LList, IList, PList, line);
export const ListChecks = createIcon("ListChecks", LListChecks, IListChecks, PListChecks, line);
export const MagnifyingGlass = createIcon("MagnifyingGlass", LSearch, ISearch, PSearch, line);
export const MagnifyingGlassMinus = createIcon("MagnifyingGlassMinus", LZoomOut, IZoomOut, PZoomOut, line);
export const MagnifyingGlassPlus = createIcon("MagnifyingGlassPlus", LZoomIn, IZoomIn, PZoomIn, line);
export const Minus = createIcon("Minus", LMinus, IMinus, PMinus, line);
export const Notebook = createIcon("Notebook", LNotebook, INotebook, PNotebook);
export const NotePencil = createIcon("NotePencil", LNote, INote, PNote);
export const Palette = createIcon("Palette", LPalette, IPalette, PPalette);
export const PencilSimpleLine = createIcon("PencilSimpleLine", LPencil, IPencil, PPencil);
export const Plus = createIcon("Plus", LPlus, IPlus, PPlus, line);
export const Question = createIcon("Question", LQuestion, IQuestion, PQuestion);
export const SidebarSimple = createIcon("SidebarSimple", LSidebar, ISidebar, PSidebar, { sidebar: true });
export const SlidersHorizontal = createIcon("SlidersHorizontal", LSettings, ISettings, PSettings, line);
export const SortAscending = createIcon("SortAscending", LSort, ISort, PSort, line);
export const Tag = createIcon("Tag", LTag, ITag, PTag);
export const TextAa = createIcon("TextAa", LText, IText, PText, line);
export const Translate = createIcon("Translate", LTranslate, ITranslate, PTranslate, line);
export const Trash = createIcon("Trash", LTrash, ITrash, PTrash);
export const Tray = createIcon("Tray", LTray, ITray, PTray);
export const WarningCircle = createIcon("WarningCircle", LWarning, IWarning, PWarning);
export const X = createIcon("X", LX, IX, PX, line);
export const GlossaryIcon = createIcon("GlossaryIcon", LBookMarked, IBookMarked, PBookMarked);
export const InsightIcon = createIcon("InsightIcon", LInsight, IInsight, PInsight);
